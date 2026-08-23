-- Durable per-stage state for progression runs.
-- Supabase remains the source of truth; provider conversation state is never authoritative.
-- Production migration applied 2026-08-23.

create table if not exists public.progression_run_steps (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_inference_jobs(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  target_date date not null,
  step text not null,
  status text not null default 'pending' check (status in ('pending','running','succeeded','failed','blocked')),
  input_hash text,
  artifact_type text,
  artifact_id text,
  schema_version text,
  provider_id text,
  model_id text,
  request_id text,
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  repair_attempt_count smallint not null default 0 check (repair_attempt_count >= 0),
  error_class text,
  error_code text,
  validator_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  latency_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, step)
);

create index if not exists progression_run_steps_user_date_idx
  on public.progression_run_steps(user_id, target_date, created_at desc);

alter table public.progression_run_steps enable row level security;
revoke all on public.progression_run_steps from anon, authenticated;

create or replace function public.start_progression_run_step(
  p_job_id uuid,
  p_worker_id text,
  p_step text,
  p_input_hash text default null,
  p_schema_version text default null
)
returns public.progression_run_steps
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_step public.progression_run_steps;
begin
  select * into v_job
  from public.ai_inference_jobs
  where id = p_job_id and status = 'running' and worker_id = p_worker_id
  for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;

  insert into public.progression_run_steps(
    job_id,user_id,target_date,step,status,input_hash,schema_version,attempt_count,started_at,completed_at,latency_ms,error_class,error_code,validator_code,error_message,updated_at
  ) values (
    v_job.id,v_job.user_id,v_job.target_date,p_step,'running',p_input_hash,p_schema_version,1,now(),null,null,null,null,null,null,now()
  )
  on conflict(job_id,step) do update
  set status='running',
      input_hash=coalesce(excluded.input_hash,public.progression_run_steps.input_hash),
      schema_version=coalesce(excluded.schema_version,public.progression_run_steps.schema_version),
      attempt_count=public.progression_run_steps.attempt_count+1,
      started_at=now(),completed_at=null,latency_ms=null,
      error_class=null,error_code=null,validator_code=null,error_message=null,updated_at=now()
  returning * into v_step;
  return v_step;
end;
$function$;

create or replace function public.complete_progression_run_step(
  p_job_id uuid,
  p_worker_id text,
  p_step text,
  p_status text,
  p_artifact_type text default null,
  p_artifact_id text default null,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_repair_attempt_count smallint default 0,
  p_error_class text default null,
  p_error_code text default null,
  p_validator_code text default null,
  p_error_message text default null
)
returns public.progression_run_steps
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_step public.progression_run_steps;
  v_safe_message text;
begin
  if p_status not in ('succeeded','failed','blocked') then raise exception 'Invalid progression step terminal status'; end if;
  select * into v_job from public.ai_inference_jobs where id=p_job_id and worker_id=p_worker_id for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;

  -- Internal diagnostics are bounded. Never persist prompts/model payloads here.
  v_safe_message := case
    when p_error_message is null then null
    else left(regexp_replace(p_error_message, '[\r\n\t]+', ' ', 'g'), 500)
  end;

  update public.progression_run_steps
  set status=p_status,
      artifact_type=coalesce(p_artifact_type,artifact_type),
      artifact_id=coalesce(p_artifact_id,artifact_id),
      provider_id=coalesce(p_provider_id,provider_id),
      model_id=coalesce(p_model_id,model_id),
      request_id=coalesce(p_request_id,request_id),
      repair_attempt_count=greatest(repair_attempt_count,coalesce(p_repair_attempt_count,0)),
      error_class=p_error_class,error_code=p_error_code,validator_code=p_validator_code,error_message=v_safe_message,
      completed_at=now(),
      latency_ms=case when started_at is null then null else greatest(0, floor(extract(epoch from (now()-started_at))*1000)::integer) end,
      updated_at=now()
  where job_id=p_job_id and step=p_step
  returning * into v_step;

  if not found then raise exception 'Progression step was not started'; end if;
  return v_step;
end;
$function$;

-- Resolve exact overload signatures from pg_proc instead of hard-coding defaulted arg lists.
do $acl$
declare
  v_start regprocedure;
  v_complete regprocedure;
begin
  select p.oid::regprocedure into v_start
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='start_progression_run_step'
  order by p.oid desc limit 1;

  select p.oid::regprocedure into v_complete
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='complete_progression_run_step'
  order by p.oid desc limit 1;

  if v_start is null or v_complete is null then raise exception 'Progression step RPC creation failed'; end if;
  execute format('revoke all on function %s from public, anon, authenticated', v_start);
  execute format('grant execute on function %s to service_role', v_start);
  execute format('revoke all on function %s from public, anon, authenticated', v_complete);
  execute format('grant execute on function %s to service_role', v_complete);
end;
$acl$;
