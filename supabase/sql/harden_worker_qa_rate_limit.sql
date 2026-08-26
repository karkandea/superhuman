begin;

alter table public.worker_qa_iterations
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists provider_rate_limit_count integer not null default 0 check (provider_rate_limit_count >= 0);

create index if not exists worker_qa_iterations_available_idx
  on public.worker_qa_iterations(status, available_at, created_at);

create or replace function public.claim_worker_qa_iteration(
  p_worker_id text,
  p_release_sha text,
  p_lease_seconds integer default 900
)
returns table(
  iteration_id uuid,
  run_id uuid,
  scenario text,
  fixture_version text,
  iteration_no integer,
  worker_attempt integer
)
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_iteration public.worker_qa_iterations;
  v_run public.worker_qa_runs;
begin
  if coalesce(btrim(p_worker_id),'') = '' then
    raise exception 'QA worker id is required';
  end if;
  if coalesce(btrim(p_release_sha),'') = '' then
    raise exception 'QA release sha is required';
  end if;
  if p_lease_seconds < 120 or p_lease_seconds > 1800 then
    raise exception 'QA lease must be between 120 and 1800 seconds';
  end if;

  -- Production work always wins resource priority.
  if exists (
    select 1
    from public.ai_inference_jobs j
    where j.status='running'
       or (
         j.status='queued'
         and j.available_at <= now()
         and j.attempt_count < j.max_attempts
       )
  ) then
    return;
  end if;

  select i.* into v_iteration
  from public.worker_qa_iterations i
  join public.worker_qa_runs r on r.id=i.run_id
  where r.status in ('queued','running')
    and (
      (i.status='queued' and i.available_at <= now())
      or (i.status='running' and i.lease_expires_at is not null and i.lease_expires_at < now())
    )
  order by r.created_at, i.available_at, i.iteration_no
  for update of i skip locked
  limit 1;

  if not found then return; end if;

  select * into v_run
  from public.worker_qa_runs
  where id=v_iteration.run_id
  for update;

  update public.worker_qa_iterations
  set status='running',
      worker_attempt_count=worker_attempt_count+1,
      worker_id=p_worker_id,
      release_sha=p_release_sha,
      lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      started_at=now(),
      completed_at=null,
      duration_ms=null,
      validator_passed=null,
      error_code=null,
      error_message=null,
      output=null,
      checkpoints='[]'::jsonb,
      updated_at=now()
  where id=v_iteration.id
  returning * into v_iteration;

  update public.worker_qa_runs
  set status='running',
      release_sha=coalesce(release_sha,p_release_sha),
      worker_id=p_worker_id,
      started_at=coalesce(started_at,now()),
      updated_at=now()
  where id=v_run.id;

  return query select
    v_iteration.id,
    v_run.id,
    v_run.scenario,
    v_run.fixture_version,
    v_iteration.iteration_no,
    v_iteration.worker_attempt_count;
end;
$function$;

revoke all on function public.claim_worker_qa_iteration(text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_worker_qa_iteration(text, text, integer) to service_role;

create or replace function public.schedule_worker_qa_rate_limit_retry(
  p_iteration_id uuid,
  p_worker_id text,
  p_cooldown_seconds integer default 900,
  p_max_rate_limit_retries integer default 2,
  p_error_message text default null
)
returns text
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_run_id uuid;
  v_next_count integer;
  v_status text;
begin
  if p_cooldown_seconds < 60 or p_cooldown_seconds > 3600 then
    raise exception 'QA rate-limit cooldown must be between 60 and 3600 seconds';
  end if;
  if p_max_rate_limit_retries < 0 or p_max_rate_limit_retries > 5 then
    raise exception 'QA rate-limit retry budget must be between 0 and 5';
  end if;

  select run_id, provider_rate_limit_count + 1
  into v_run_id, v_next_count
  from public.worker_qa_iterations
  where id=p_iteration_id
    and status='running'
    and worker_id=p_worker_id
  for update;

  if v_run_id is null then
    raise exception 'QA iteration is not owned by this worker';
  end if;

  if exists(select 1 from public.worker_qa_runs where id=v_run_id and status='cancelled') then
    update public.worker_qa_iterations
    set status='cancelled',
        provider_rate_limit_count=v_next_count,
        lease_expires_at=null,
        completed_at=now(),
        updated_at=now()
    where id=p_iteration_id;
    return 'cancelled';
  end if;

  if v_next_count <= p_max_rate_limit_retries then
    update public.worker_qa_iterations
    set status='queued',
        provider_rate_limit_count=v_next_count,
        available_at=now()+make_interval(secs=>p_cooldown_seconds),
        lease_expires_at=null,
        worker_id=null,
        error_code='provider_rate_limited',
        error_message=nullif(left(regexp_replace(coalesce(p_error_message,''),'[\r\n\t]+',' ','g'),500),''),
        completed_at=null,
        updated_at=now()
    where id=p_iteration_id;
    v_status := 'queued';
  else
    update public.worker_qa_iterations
    set status='failed',
        provider_rate_limit_count=v_next_count,
        lease_expires_at=null,
        error_code='provider_rate_limited',
        error_message=nullif(left(regexp_replace(coalesce(p_error_message,''),'[\r\n\t]+',' ','g'),500),''),
        completed_at=now(),
        updated_at=now()
    where id=p_iteration_id;
    perform public.refresh_worker_qa_run_summary(v_run_id);
    v_status := 'failed';
  end if;

  return v_status;
end;
$function$;

revoke all on function public.schedule_worker_qa_rate_limit_retry(uuid,text,integer,integer,text) from public, anon, authenticated;
grant execute on function public.schedule_worker_qa_rate_limit_retry(uuid,text,integer,integer,text) to service_role;

create or replace function public.refresh_worker_qa_run_summary(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_total integer := 0;
  v_terminal integer := 0;
  v_complete integer := 0;
  v_cancelled integer := 0;
  v_success integer := 0;
  v_failure integer := 0;
  v_validator_failure integer := 0;
  v_recovery integer := 0;
  v_avg integer;
  v_p95 integer;
  v_error_distribution jsonb := '{}'::jsonb;
  v_release_count integer := 0;
  v_status text;
begin
  select
    count(*),
    count(*) filter (where status in ('succeeded','failed')),
    count(*) filter (where status in ('succeeded','failed','cancelled')),
    count(*) filter (where status='cancelled'),
    count(*) filter (where status='succeeded' and coalesce(validator_passed,true)),
    count(*) filter (where status='failed'),
    count(*) filter (where status='failed' and error_code='validator_failed'),
    coalesce(sum(recovery_count),0),
    round(avg(duration_ms))::integer,
    percentile_disc(0.95) within group (order by duration_ms)::integer,
    count(distinct release_sha) filter (where release_sha is not null)
  into
    v_total,
    v_terminal,
    v_complete,
    v_cancelled,
    v_success,
    v_failure,
    v_validator_failure,
    v_recovery,
    v_avg,
    v_p95,
    v_release_count
  from public.worker_qa_iterations
  where run_id=p_run_id;

  select coalesce(jsonb_object_agg(error_code, failure_count), '{}'::jsonb)
  into v_error_distribution
  from (
    select coalesce(error_code,'unknown') as error_code, count(*) as failure_count
    from public.worker_qa_iterations
    where run_id=p_run_id and status='failed'
    group by coalesce(error_code,'unknown')
  ) failures;

  select status into v_status from public.worker_qa_runs where id=p_run_id;
  if v_status='cancelled' then
    return;
  end if;

  update public.worker_qa_runs
  set success_count=v_success,
      failure_count=v_failure,
      validator_failure_count=v_validator_failure,
      recovery_count=v_recovery,
      average_duration_ms=v_avg,
      p95_duration_ms=v_p95,
      result_summary=jsonb_build_object(
        'total',v_total,
        'terminal',v_terminal,
        'complete',v_complete,
        'cancelledCount',v_cancelled,
        'technicalSuccessCount',v_success,
        'failureCount',v_failure,
        'validatorFailureCount',v_validator_failure,
        'recoveryCount',v_recovery,
        'successRate',case when v_terminal=0 then 0 else round((v_success::numeric/v_terminal::numeric)*100,2) end,
        'errorDistribution',v_error_distribution,
        'mixedRelease',v_release_count > 1
      ),
      status=case
        when v_complete < v_total then 'running'
        when v_failure=0 and v_validator_failure=0 then 'succeeded'
        else 'failed'
      end,
      completed_at=case when v_complete=v_total then now() else null end,
      updated_at=now()
  where id=p_run_id;
end;
$function$;

revoke all on function public.refresh_worker_qa_run_summary(uuid) from public, anon, authenticated;
grant execute on function public.refresh_worker_qa_run_summary(uuid) to service_role;

commit;
