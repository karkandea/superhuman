-- Durable per-attempt inference history.
-- ai_inference_jobs remains the current workflow state; this table preserves retry causes
-- after a later claim clears the job-level error fields.

create table if not exists public.ai_inference_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_inference_jobs(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  target_date date not null,
  attempt_number smallint not null check (attempt_number >= 0),
  worker_id text not null,
  status text not null check (status in ('running','retrying','succeeded','failed','blocked_auth','paused_rate_limit')),
  provider_id text,
  request_id text,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ai_inference_attempts_job_idx
  on public.ai_inference_attempts(job_id, started_at desc);
create index if not exists ai_inference_attempts_user_date_idx
  on public.ai_inference_attempts(user_id, target_date desc, started_at desc);
create index if not exists ai_inference_attempts_error_idx
  on public.ai_inference_attempts(error_code, started_at desc)
  where error_code is not null;

alter table public.ai_inference_attempts enable row level security;
revoke all on table public.ai_inference_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_inference_attempts to service_role;

create or replace function public.claim_ai_inference_job(p_worker_id text, p_lease_seconds integer default 300)
returns setof public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare v_job public.ai_inference_jobs;
begin
  if coalesce(btrim(p_worker_id),'')='' then raise exception 'worker id is required'; end if;
  if p_lease_seconds < 30 or p_lease_seconds > 1800 then raise exception 'lease must be between 30 and 1800 seconds'; end if;

  select * into v_job from public.ai_inference_jobs
  where status <> 'paused_rate_limit'
    and attempt_count < max_attempts
    and ((status='queued' and available_at<=now()) or (status='running' and lease_expires_at is not null and lease_expires_at<now()))
  order by available_at,created_at for update skip locked limit 1;
  if not found then return; end if;

  update public.ai_inference_jobs
  set status='running',
      attempt_count=case when v_job.error_code='provider_rate_limited' then attempt_count else attempt_count+1 end,
      worker_id=p_worker_id,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      started_at=coalesce(started_at,now()),
      window_cutoff_at=coalesce(window_cutoff_at,now()),
      activity_window_started_at=case when v_job.window_cutoff_at is null then null else activity_window_started_at end,
      error_code=null,error_message=null,updated_at=now()
  where id=v_job.id returning * into v_job;

  insert into public.ai_inference_attempts(
    job_id,user_id,target_date,attempt_number,worker_id,status,provider_id,started_at
  ) values (
    v_job.id,v_job.user_id,v_job.target_date,v_job.attempt_count,p_worker_id,'running',v_job.provider_id,now()
  );

  return next v_job;
  return;
end;
$function$;

revoke execute on function public.claim_ai_inference_job(text,integer) from public, anon, authenticated;
grant execute on function public.claim_ai_inference_job(text,integer) to service_role;

create or replace function public.schedule_ai_inference_retry(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_delay_seconds integer default 5,
  p_provider_id text default null,
  p_provider_conversation_refs jsonb default '[]'::jsonb
)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_rate_limit_count integer := 0;
  v_delay_seconds integer;
  v_safe_code text := public.safe_ai_failure_code(p_error_code,p_error_message);
  v_safe_message text := public.safe_ai_failure_message(p_error_code,p_error_message);
  v_request_id text := public.extract_ai_request_id(p_error_message);
  v_attempt_status text;
begin
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs) <> 'array' then
    raise exception 'provider conversation refs must be a JSON array';
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where id = p_job_id and status = 'running' and worker_id = p_worker_id
  for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;

  if coalesce(v_job.result_summary->>'decisionPoint','') = 'initialization_calibration' and v_request_id is not null then
    update public.player_initialization_calibration_attempts
    set request_id = v_request_id
    where job_id = p_job_id and attempt_number = v_job.attempt_count;
  end if;

  if p_error_code = 'model_output_invalid' then
    v_attempt_status := 'failed';
    update public.ai_inference_jobs
    set status = 'failed',
        lease_expires_at = null,
        worker_id = null,
        provider_id = coalesce(p_provider_id, provider_id),
        provider_conversation_refs = provider_conversation_refs || p_provider_conversation_refs,
        error_code = v_safe_code,
        error_message = v_safe_message,
        completed_at = now(),
        updated_at = now()
    where id = p_job_id
    returning * into v_job;
  elsif p_error_code = 'provider_rate_limited' then
    if coalesce(v_job.result_summary->>'provider_rate_limit_count','') ~ '^\d+$' then
      v_rate_limit_count := (v_job.result_summary->>'provider_rate_limit_count')::integer;
    end if;
    v_rate_limit_count := v_rate_limit_count + 1;
    if v_rate_limit_count >= 3 then
      v_attempt_status := 'paused_rate_limit';
      update public.ai_inference_jobs
      set status='paused_rate_limit',lease_expires_at=null,worker_id=null,
          provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
          result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object('provider_rate_limit_count',v_rate_limit_count,'circuit_breaker','open'),
          error_code=v_safe_code,error_message=v_safe_message,completed_at=now(),updated_at=now()
      where id=p_job_id returning * into v_job;
    else
      v_attempt_status := 'retrying';
      v_delay_seconds := case when v_rate_limit_count=1 then 900 else 1800 end;
      update public.ai_inference_jobs
      set status='queued',available_at=now()+make_interval(secs=>v_delay_seconds),lease_expires_at=null,worker_id=null,
          provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
          result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object('provider_rate_limit_count',v_rate_limit_count,'circuit_breaker','closed'),
          error_code=v_safe_code,error_message=v_safe_message,completed_at=null,updated_at=now()
      where id=p_job_id returning * into v_job;
    end if;
  elsif v_job.attempt_count >= v_job.max_attempts then
    v_attempt_status := 'failed';
    update public.ai_inference_jobs
    set status='failed',lease_expires_at=null,worker_id=null,
        provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
        error_code=v_safe_code,error_message=v_safe_message,completed_at=now(),updated_at=now()
    where id=p_job_id returning * into v_job;
  else
    v_attempt_status := 'retrying';
    update public.ai_inference_jobs
    set status='queued',available_at=now()+make_interval(secs=>greatest(1,least(p_delay_seconds,300))),
        lease_expires_at=null,worker_id=null,provider_id=coalesce(p_provider_id,provider_id),
        provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,error_code=v_safe_code,error_message=v_safe_message,updated_at=now()
    where id=p_job_id returning * into v_job;
  end if;

  update public.ai_inference_attempts
  set status=v_attempt_status,
      provider_id=coalesce(p_provider_id,provider_id),
      request_id=coalesce(v_request_id,request_id),
      error_code=v_safe_code,
      error_message=left(coalesce(v_safe_message,''),1000),
      completed_at=now(),
      latency_ms=greatest(0,(extract(epoch from (now()-started_at))*1000)::integer)
  where id=(
    select id from public.ai_inference_attempts
    where job_id=p_job_id and worker_id=p_worker_id and status='running'
    order by started_at desc
    limit 1
  );

  return v_job;
end;
$function$;

revoke execute on function public.schedule_ai_inference_retry(uuid,text,text,text,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.schedule_ai_inference_retry(uuid,text,text,text,integer,text,jsonb) to service_role;

create or replace function public.complete_ai_inference_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_provider_id text default null,
  p_provider_conversation_refs jsonb default '[]'::jsonb,
  p_result_summary jsonb default '{}'::jsonb,
  p_error_code text default null,
  p_error_message text default null
)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_window_start timestamptz;
  v_next_available timestamptz;
  v_safe_code text:=public.safe_ai_failure_code(p_error_code,p_error_message);
  v_safe_message text:=public.safe_ai_failure_message(p_error_code,p_error_message);
  v_request_id text:=public.extract_ai_request_id(p_error_message);
  v_summary jsonb;
  v_attempt_status text;
begin
  if p_status not in ('succeeded','failed','blocked_auth') then raise exception 'Unsupported terminal inference status'; end if;
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs)<>'array' then raise exception 'provider conversation refs must be a JSON array'; end if;
  if p_result_summary is null or jsonb_typeof(p_result_summary)<>'object' then raise exception 'result summary must be a JSON object'; end if;
  select * into v_job from public.ai_inference_jobs where id=p_job_id and status='running' and worker_id=p_worker_id for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;
  v_summary:=coalesce(v_job.result_summary,'{}'::jsonb)||p_result_summary;

  if coalesce(v_job.result_summary->>'decisionPoint','')='initialization_calibration' and v_request_id is not null then
    update public.player_initialization_calibration_attempts set request_id=v_request_id
    where job_id=p_job_id and attempt_number=v_job.attempt_count;
  end if;

  v_attempt_status := case
    when p_status='blocked_auth' then 'blocked_auth'
    when p_status='failed' then 'failed'
    else 'succeeded'
  end;

  update public.ai_inference_attempts
  set status=v_attempt_status,
      provider_id=coalesce(p_provider_id,provider_id),
      request_id=coalesce(v_request_id,request_id),
      error_code=case when p_status='succeeded' then null else v_safe_code end,
      error_message=case when p_status='succeeded' then null else left(coalesce(v_safe_message,''),1000) end,
      completed_at=now(),
      latency_ms=greatest(0,(extract(epoch from (now()-started_at))*1000)::integer)
  where id=(
    select id from public.ai_inference_attempts
    where job_id=p_job_id and worker_id=p_worker_id and status='running'
    order by started_at desc
    limit 1
  );

  if p_status='succeeded' and v_job.rerun_requested then
    v_window_start:=coalesce(v_job.activity_window_started_at,now());
    v_next_available:=least(now()+interval '2 minutes',v_window_start+interval '10 minutes');
    update public.ai_inference_jobs set status='queued',correlation_id=gen_random_uuid(),attempt_count=0,available_at=v_next_available,lease_expires_at=null,
      worker_id=null,rerun_requested=false,provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs='[]'::jsonb,result_summary=v_summary,
      error_code=null,error_message=null,started_at=null,completed_at=null,activity_window_started_at=v_window_start,window_cutoff_at=null,updated_at=now()
    where id=p_job_id returning * into v_job;
    return v_job;
  end if;

  update public.ai_inference_jobs set status=p_status,lease_expires_at=null,worker_id=null,rerun_requested=false,
    provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
    result_summary=v_summary,error_code=case when p_status='succeeded' then null else v_safe_code end,
    error_message=case when p_status='succeeded' then '' else v_safe_message end,completed_at=now(),activity_window_started_at=null,window_cutoff_at=null,updated_at=now()
  where id=p_job_id returning * into v_job;
  return v_job;
end;
$function$;

revoke execute on function public.complete_ai_inference_job(uuid,text,text,text,jsonb,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.complete_ai_inference_job(uuid,text,text,text,jsonb,jsonb,text,text) to service_role;
