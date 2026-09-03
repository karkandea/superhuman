-- Manual Relay Provider.
-- Keeps the progression core/provider contract intact while replacing browser automation
-- with a human-operated ChatGPT relay. The legacy browser worker schema/code remains intact.

alter table public.ai_inference_jobs drop constraint if exists ai_inference_jobs_status_check;
alter table public.ai_inference_jobs
  add constraint ai_inference_jobs_status_check
  check (status in ('queued','running','waiting_operator','succeeded','failed','blocked_auth','paused_rate_limit'));

alter table public.ai_inference_attempts drop constraint if exists ai_inference_attempts_status_check;
alter table public.ai_inference_attempts
  add constraint ai_inference_attempts_status_check
  check (status in ('running','waiting_operator','retrying','succeeded','failed','blocked_auth','paused_rate_limit'));

create table if not exists public.manual_inference_turns (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_inference_jobs(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  target_date date not null,
  operation text not null,
  schema_version text not null,
  request_hash text not null,
  request_id text not null,
  prompt text not null,
  requires_web_search boolean not null default false,
  status text not null default 'pending' check (status in ('pending','submitted','consumed','invalid','cancelled')),
  raw_response text,
  parsed_response jsonb,
  model_id text,
  validation_error text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  consumed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(job_id, request_hash)
);

create index if not exists manual_inference_turns_status_idx
  on public.manual_inference_turns(status, created_at asc);
create index if not exists manual_inference_turns_job_idx
  on public.manual_inference_turns(job_id, created_at asc);
create index if not exists manual_inference_turns_user_date_idx
  on public.manual_inference_turns(user_id, target_date desc, created_at desc);

alter table public.manual_inference_turns enable row level security;
revoke all on table public.manual_inference_turns from public, anon, authenticated;
grant select, insert, update, delete on table public.manual_inference_turns to service_role;

create or replace function public.pause_ai_inference_job_for_operator(
  p_job_id uuid,
  p_worker_id text,
  p_turn_id uuid
)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_turn public.manual_inference_turns;
begin
  select * into v_job
  from public.ai_inference_jobs
  where id = p_job_id and status = 'running' and worker_id = p_worker_id
  for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;

  select * into v_turn
  from public.manual_inference_turns
  where id = p_turn_id and job_id = p_job_id
  for update;
  if not found then raise exception 'Manual inference turn does not belong to this job'; end if;

  update public.ai_inference_attempts
  set status = 'waiting_operator',
      provider_id = 'manual-relay',
      completed_at = now(),
      latency_ms = greatest(0,(extract(epoch from (now()-started_at))*1000)::integer)
  where id = (
    select id from public.ai_inference_attempts
    where job_id = p_job_id and worker_id = p_worker_id and status = 'running'
    order by started_at desc
    limit 1
  );

  update public.ai_inference_jobs
  set status = 'waiting_operator',
      lease_expires_at = null,
      worker_id = null,
      provider_id = 'manual-relay',
      result_summary = coalesce(result_summary,'{}'::jsonb) || jsonb_build_object(
        'manualTurnId', p_turn_id,
        'manualOperation', v_turn.operation
      ),
      error_code = null,
      error_message = null,
      completed_at = null,
      updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$function$;

create or replace function public.resume_ai_inference_job_from_operator(p_turn_id uuid)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_turn public.manual_inference_turns;
  v_job public.ai_inference_jobs;
begin
  select * into v_turn
  from public.manual_inference_turns
  where id = p_turn_id
  for update;
  if not found then raise exception 'Manual inference turn not found'; end if;
  if v_turn.status not in ('submitted','consumed') then
    raise exception 'Manual inference turn must be submitted before resume';
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where id = v_turn.job_id
  for update;
  if not found then raise exception 'Inference job not found'; end if;

  if v_job.status = 'waiting_operator' then
    update public.ai_inference_jobs
    set status = 'queued',
        available_at = now(),
        lease_expires_at = null,
        worker_id = null,
        -- A human relay pause is not a failed inference attempt. Compensate for the
        -- claim counter so a multi-turn progression run cannot exhaust max_attempts.
        attempt_count = greatest(attempt_count - 1, 0),
        error_code = null,
        error_message = null,
        completed_at = null,
        updated_at = now()
    where id = v_job.id
    returning * into v_job;
  end if;

  return v_job;
end;
$function$;

revoke execute on function public.pause_ai_inference_job_for_operator(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.pause_ai_inference_job_for_operator(uuid,text,uuid) to service_role;
revoke execute on function public.resume_ai_inference_job_from_operator(uuid) from public, anon, authenticated;
grant execute on function public.resume_ai_inference_job_from_operator(uuid) to service_role;
