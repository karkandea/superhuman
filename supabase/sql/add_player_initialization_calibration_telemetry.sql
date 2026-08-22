-- Privacy-safe telemetry for Player Initialization calibration attempts.
-- This intentionally stores answer shape/volume only, never answer or transcript content.

create table if not exists public.player_initialization_calibration_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  job_id uuid not null references public.ai_inference_jobs(id) on delete cascade,
  correlation_id uuid not null,
  attempt_number smallint not null check (attempt_number >= 1),
  calibration_version integer not null check (calibration_version >= 0),
  is_first_calibration boolean not null default false,
  status text not null default 'running' check (status in ('running','ready','ask','failed')),
  answered_count smallint not null default 0 check (answered_count >= 0),
  skipped_count smallint not null default 0 check (skipped_count >= 0),
  text_answer_count smallint not null default 0 check (text_answer_count >= 0),
  text_length_chars integer not null default 0 check (text_length_chars >= 0),
  audio_answer_count smallint not null default 0 check (audio_answer_count >= 0),
  audio_duration_ms bigint not null default 0 check (audio_duration_ms >= 0),
  answer_metrics jsonb not null default '[]'::jsonb check (jsonb_typeof(answer_metrics) = 'array'),
  adaptive_followups_generated smallint not null default 0 check (adaptive_followups_generated >= 0),
  request_id text,
  provider_id text,
  failure_code text,
  failure_reason text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now(),
  unique (job_id, attempt_number)
);

create index if not exists player_initialization_calibration_attempts_user_started_idx
  on public.player_initialization_calibration_attempts(user_id, started_at desc);
create index if not exists player_initialization_calibration_attempts_job_idx
  on public.player_initialization_calibration_attempts(job_id, attempt_number);

alter table public.player_initialization_calibration_attempts enable row level security;
revoke all on table public.player_initialization_calibration_attempts from anon, authenticated;
grant all on table public.player_initialization_calibration_attempts to service_role;

create or replace function public.extract_ai_request_id(p_error_message text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif((regexp_match(coalesce(p_error_message,''), '\[requestId=([^]]+)\]'))[1], '')
$$;

create or replace function public.safe_ai_failure_code(p_error_code text, p_error_message text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_code text := nullif(btrim(coalesce(p_error_code,'')),'');
  v_message text := lower(coalesce(p_error_message,''));
begin
  if v_code in (
    'composer_fill_timeout','attachment_upload_timeout','composer_send_timeout','composer_send_unavailable',
    'attachment_upload_unavailable','attachment_download_failed','composer_not_found','browser_challenge',
    'browser_auth_required','provider_rate_limited','generation_timeout'
  ) then return v_code; end if;
  if v_message like '%locator.fill:%timeout%' then return 'composer_fill_timeout'; end if;
  if v_message like '%setinputfiles%' and v_message like '%timeout%' then return 'attachment_upload_timeout'; end if;
  if v_message like '%prompt composer was not found%' then return 'composer_not_found'; end if;
  if v_message like '%file attachment input was not available%' then return 'attachment_upload_unavailable'; end if;
  if v_message like '%audio evidence could not be loaded%' then return 'attachment_download_failed'; end if;
  if v_message like '%browser challenge blocked%' then return 'browser_challenge'; end if;
  if v_message like '%browser session is not authenticated%' then return 'browser_auth_required'; end if;
  if v_message like '%rate-limited%' then return 'provider_rate_limited'; end if;
  if v_message like '%timeout%' then return 'transient_transport_error'; end if;
  return coalesce(v_code,'inference_failed');
end;
$$;

create or replace function public.safe_ai_failure_message(p_error_code text, p_error_message text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_code text := public.safe_ai_failure_code(p_error_code,p_error_message);
begin
  return case v_code
    when 'composer_fill_timeout' then 'ChatGPT composer did not accept the request before timeout.'
    when 'attachment_upload_timeout' then 'ChatGPT attachment upload did not become ready before timeout.'
    when 'composer_send_timeout' then 'ChatGPT send action did not complete before timeout.'
    when 'composer_send_unavailable' then 'ChatGPT send control did not become ready before timeout.'
    when 'generation_timeout' then 'ChatGPT response exceeded the generation timeout.'
    when 'composer_not_found' then 'ChatGPT prompt composer was not available.'
    when 'attachment_upload_unavailable' then 'ChatGPT attachment upload control was not available.'
    when 'attachment_download_failed' then 'One or more stored audio answers could not be loaded by the worker.'
    when 'browser_challenge' then 'ChatGPT browser challenge blocked the worker.'
    when 'browser_auth_required' then 'ChatGPT browser session requires authentication.'
    when 'provider_rate_limited' then 'ChatGPT temporarily rate-limited the worker session.'
    when 'model_output_invalid' then 'Model response failed the required output contract.'
    when 'transient_transport_error' then 'Temporary ChatGPT browser transport failure.'
    when 'insufficient_context' then 'Calibration did not have enough bounded evidence to continue.'
    when 'stale_player_brief' then 'Calibration state changed before persistence completed.'
    else 'AI inference attempt failed before completion.'
  end;
end;
$$;

create or replace function public.capture_player_initialization_calibration_attempt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_calibration_version integer := 0;
  v_readiness text := 'ask';
  v_answered integer := 0;
  v_skipped integer := 0;
  v_text_count integer := 0;
  v_text_length integer := 0;
  v_audio_count integer := 0;
  v_audio_duration bigint := 0;
  v_metrics jsonb := '[]'::jsonb;
  v_followups integer := 0;
begin
  if coalesce(new.result_summary->>'decisionPoint','') <> 'initialization_calibration' then return new; end if;

  if old.status='running' and new.status='running' and new.attempt_count>old.attempt_count then
    update public.player_initialization_calibration_attempts
    set status='failed',failure_code='worker_lease_expired',
        failure_reason='Worker lease expired before the calibration attempt completed.',completed_at=now(),
        latency_ms=greatest(0,floor(extract(epoch from (now()-started_at))*1000)::integer)
    where job_id=new.id and attempt_number=old.attempt_count and status='running';
  end if;

  if new.status='running' and (old.status is distinct from 'running' or new.attempt_count>old.attempt_count) then
    select coalesce(i.calibration_version,0),coalesce(i.readiness,'ask')
      into v_calibration_version,v_readiness
    from public.player_initializations i where i.user_id=new.user_id;

    select
      count(*) filter(where q.status='answered'),
      count(*) filter(where q.status='skipped'),
      count(*) filter(where q.status='answered' and q.answer_mode='text'),
      coalesce(sum(case when q.status='answered' and q.answer_mode='text' then char_length(coalesce(q.answer_text,'')) else 0 end),0),
      count(*) filter(where q.status='answered' and q.answer_mode='audio'),
      coalesce(sum(case when q.status='answered' and q.answer_mode='audio' then coalesce(q.answer_audio_duration_ms,0) else 0 end),0),
      coalesce(jsonb_agg(jsonb_build_object(
        'questionKey',q.question_key,'origin',q.origin,'calibrationVersion',q.calibration_version,
        'status',q.status,'answerMode',case when q.status='answered' then q.answer_mode else null end,
        'textLength',case when q.status='answered' and q.answer_mode='text' then char_length(coalesce(q.answer_text,'')) else null end,
        'audioDurationMs',case when q.status='answered' and q.answer_mode='audio' then q.answer_audio_duration_ms else null end
      ) order by q.sequence,q.created_at),'[]'::jsonb)
      into v_answered,v_skipped,v_text_count,v_text_length,v_audio_count,v_audio_duration,v_metrics
    from public.player_initialization_questions q
    where q.user_id=new.user_id and q.status<>'superseded';

    insert into public.player_initialization_calibration_attempts(
      user_id,job_id,correlation_id,attempt_number,calibration_version,is_first_calibration,status,
      answered_count,skipped_count,text_answer_count,text_length_chars,audio_answer_count,audio_duration_ms,
      answer_metrics,request_id,provider_id,started_at)
    values(new.user_id,new.id,new.correlation_id,new.attempt_count,v_calibration_version,(v_calibration_version=0),'running',
      v_answered,v_skipped,v_text_count,v_text_length,v_audio_count,v_audio_duration,v_metrics,null,
      coalesce(new.provider_id,'chatgpt-consumer-web'),now())
    on conflict(job_id,attempt_number) do nothing;
  end if;

  if old.status='running' and new.status<>'running' then
    if new.status='succeeded' then
      select coalesce(i.readiness,'ask'),coalesce(i.calibration_version,0)
        into v_readiness,v_calibration_version
      from public.player_initializations i where i.user_id=new.user_id;
      select count(*) into v_followups
      from public.player_initialization_questions q
      where q.user_id=new.user_id and q.origin='adaptive' and q.calibration_version=v_calibration_version;
      update public.player_initialization_calibration_attempts a
      set status=case when v_readiness='ready' then 'ready' else 'ask' end,
          adaptive_followups_generated=least(v_followups,32767)::smallint,
          request_id=coalesce((select i.last_request_id from public.player_initializations i where i.user_id=new.user_id),a.request_id),
          completed_at=now(),latency_ms=greatest(0,floor(extract(epoch from (now()-a.started_at))*1000)::integer)
      where a.job_id=new.id and a.attempt_number=old.attempt_count and a.status='running';
    else
      update public.player_initialization_calibration_attempts a
      set status='failed',failure_code=new.error_code,
          failure_reason=coalesce(nullif(new.error_message,''),'AI inference attempt failed before completion.'),
          completed_at=now(),latency_ms=greatest(0,floor(extract(epoch from (now()-a.started_at))*1000)::integer)
      where a.job_id=new.id and a.attempt_number=old.attempt_count and a.status='running';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.extract_ai_request_id(text) from public;
revoke all on function public.safe_ai_failure_code(text,text) from public;
revoke all on function public.safe_ai_failure_message(text,text) from public;
revoke all on function public.capture_player_initialization_calibration_attempt() from public;

drop trigger if exists capture_player_initialization_calibration_attempt on public.ai_inference_jobs;
create trigger capture_player_initialization_calibration_attempt
after update on public.ai_inference_jobs
for each row execute function public.capture_player_initialization_calibration_attempt();

-- Keep raw browser/Playwright details out of ai_inference_jobs. The request id prefix is
-- extracted into telemetry before the safe failure message replaces the raw transport error.
create or replace function public.schedule_ai_inference_retry(
  p_job_id uuid,p_worker_id text,p_error_code text,p_error_message text,p_delay_seconds integer default 5,
  p_provider_id text default null,p_provider_conversation_refs jsonb default '[]'::jsonb)
returns public.ai_inference_jobs language plpgsql security definer set search_path=''
as $$
declare
  v_job public.ai_inference_jobs;
  v_rate_limit_count integer:=0;
  v_delay_seconds integer;
  v_safe_code text:=public.safe_ai_failure_code(p_error_code,p_error_message);
  v_safe_message text:=public.safe_ai_failure_message(p_error_code,p_error_message);
  v_request_id text:=public.extract_ai_request_id(p_error_message);
begin
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs)<>'array' then raise exception 'provider conversation refs must be a JSON array'; end if;
  select * into v_job from public.ai_inference_jobs where id=p_job_id and status='running' and worker_id=p_worker_id for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;
  if coalesce(v_job.result_summary->>'decisionPoint','')='initialization_calibration' and v_request_id is not null then
    update public.player_initialization_calibration_attempts set request_id=v_request_id
    where job_id=p_job_id and attempt_number=v_job.attempt_count;
  end if;
  if p_error_code='provider_rate_limited' then
    if coalesce(v_job.result_summary->>'provider_rate_limit_count','') ~ '^\d+$' then v_rate_limit_count:=(v_job.result_summary->>'provider_rate_limit_count')::integer; end if;
    v_rate_limit_count:=v_rate_limit_count+1;
    if v_rate_limit_count>=3 then
      update public.ai_inference_jobs set status='paused_rate_limit',lease_expires_at=null,worker_id=null,
        provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
        result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object('provider_rate_limit_count',v_rate_limit_count,'circuit_breaker','open'),
        error_code=v_safe_code,error_message=v_safe_message,completed_at=now(),updated_at=now()
      where id=p_job_id returning * into v_job; return v_job;
    end if;
    v_delay_seconds:=case when v_rate_limit_count=1 then 900 else 1800 end;
    update public.ai_inference_jobs set status='queued',available_at=now()+make_interval(secs=>v_delay_seconds),lease_expires_at=null,worker_id=null,
      provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
      result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object('provider_rate_limit_count',v_rate_limit_count,'circuit_breaker','closed'),
      error_code=v_safe_code,error_message=v_safe_message,completed_at=null,updated_at=now()
    where id=p_job_id returning * into v_job; return v_job;
  end if;
  if v_job.attempt_count>=v_job.max_attempts then
    update public.ai_inference_jobs set status='failed',lease_expires_at=null,worker_id=null,
      provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
      error_code=v_safe_code,error_message=v_safe_message,completed_at=now(),updated_at=now()
    where id=p_job_id returning * into v_job;
  else
    update public.ai_inference_jobs set status='queued',available_at=now()+make_interval(secs=>greatest(1,least(p_delay_seconds,300))),
      lease_expires_at=null,worker_id=null,provider_id=coalesce(p_provider_id,provider_id),
      provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,error_code=v_safe_code,error_message=v_safe_message,updated_at=now()
    where id=p_job_id returning * into v_job;
  end if;
  return v_job;
end;$$;

create or replace function public.complete_ai_inference_job(
  p_job_id uuid,p_worker_id text,p_status text,p_provider_id text default null,
  p_provider_conversation_refs jsonb default '[]'::jsonb,p_result_summary jsonb default '{}'::jsonb,
  p_error_code text default null,p_error_message text default null)
returns public.ai_inference_jobs language plpgsql security definer set search_path=''
as $$
declare
  v_job public.ai_inference_jobs;
  v_window_start timestamptz;
  v_next_available timestamptz;
  v_safe_code text:=public.safe_ai_failure_code(p_error_code,p_error_message);
  v_safe_message text:=public.safe_ai_failure_message(p_error_code,p_error_message);
  v_request_id text:=public.extract_ai_request_id(p_error_message);
begin
  if p_status not in ('succeeded','failed','blocked_auth') then raise exception 'Unsupported terminal inference status'; end if;
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs)<>'array' then raise exception 'provider conversation refs must be a JSON array'; end if;
  if p_result_summary is null or jsonb_typeof(p_result_summary)<>'object' then raise exception 'result summary must be a JSON object'; end if;
  select * into v_job from public.ai_inference_jobs where id=p_job_id and status='running' and worker_id=p_worker_id for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;
  if coalesce(v_job.result_summary->>'decisionPoint','')='initialization_calibration' and v_request_id is not null then
    update public.player_initialization_calibration_attempts set request_id=v_request_id
    where job_id=p_job_id and attempt_number=v_job.attempt_count;
  end if;
  if p_status='succeeded' and v_job.rerun_requested then
    v_window_start:=coalesce(v_job.activity_window_started_at,now());
    v_next_available:=least(now()+interval '2 minutes',v_window_start+interval '10 minutes');
    update public.ai_inference_jobs set status='queued',correlation_id=gen_random_uuid(),attempt_count=0,available_at=v_next_available,lease_expires_at=null,
      worker_id=null,rerun_requested=false,provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs='[]'::jsonb,result_summary=p_result_summary,
      error_code=null,error_message=null,started_at=null,completed_at=null,activity_window_started_at=v_window_start,window_cutoff_at=null,updated_at=now()
    where id=p_job_id returning * into v_job; return v_job;
  end if;
  update public.ai_inference_jobs set status=p_status,lease_expires_at=null,worker_id=null,rerun_requested=false,
    provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
    result_summary=p_result_summary,error_code=case when p_status='succeeded' then null else v_safe_code end,
    error_message=case when p_status='succeeded' then '' else v_safe_message end,completed_at=now(),activity_window_started_at=null,window_cutoff_at=null,updated_at=now()
  where id=p_job_id returning * into v_job;
  return v_job;
end;$$;
