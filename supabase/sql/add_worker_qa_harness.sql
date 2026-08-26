begin;

create table if not exists public.worker_qa_runs (
  id uuid primary key default gen_random_uuid(),
  scenario text not null,
  fixture_version text not null default 'worker-qa.v1',
  repetitions integer not null check (repetitions between 1 and 50),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  release_sha text,
  worker_id text,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  validator_failure_count integer not null default 0,
  recovery_count integer not null default 0,
  average_duration_ms integer,
  p95_duration_ms integer,
  result_summary jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint worker_qa_runs_scenario_check check (
    scenario in (
      'progression_target_normal',
      'quest_generation_normal',
      'search',
      'composer_recovery',
      'full_chain_normal'
    )
  )
);

create table if not exists public.worker_qa_iterations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.worker_qa_runs(id) on delete cascade,
  iteration_no integer not null check (iteration_no > 0),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  worker_attempt_count integer not null default 0,
  worker_id text,
  release_sha text,
  lease_expires_at timestamptz,
  duration_ms integer,
  validator_passed boolean,
  recovery_count integer not null default 0,
  error_code text,
  error_message text,
  output jsonb,
  checkpoints jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, iteration_no)
);

create table if not exists public.worker_qa_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.worker_qa_runs(id) on delete cascade,
  iteration_id uuid not null references public.worker_qa_iterations(id) on delete cascade,
  worker_attempt integer not null check (worker_attempt > 0),
  step_order integer not null check (step_order > 0),
  step_name text not null,
  operation text not null,
  status text not null check (status in ('running','succeeded','failed')),
  duration_ms integer,
  validator_passed boolean,
  recovery_count integer not null default 0,
  request_id text,
  error_code text,
  error_message text,
  output jsonb,
  validator_errors jsonb not null default '[]'::jsonb,
  checkpoints jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(iteration_id, worker_attempt, step_order)
);

create index if not exists worker_qa_runs_status_created_idx
  on public.worker_qa_runs(status, created_at);
create index if not exists worker_qa_iterations_queue_idx
  on public.worker_qa_iterations(status, created_at);
create index if not exists worker_qa_steps_iteration_idx
  on public.worker_qa_steps(iteration_id, worker_attempt, step_order);

alter table public.worker_qa_runs enable row level security;
alter table public.worker_qa_iterations enable row level security;
alter table public.worker_qa_steps enable row level security;

revoke all on table public.worker_qa_runs from public, anon, authenticated;
revoke all on table public.worker_qa_iterations from public, anon, authenticated;
revoke all on table public.worker_qa_steps from public, anon, authenticated;
grant select, insert, update, delete on table public.worker_qa_runs to service_role;
grant select, insert, update, delete on table public.worker_qa_iterations to service_role;
grant select, insert, update, delete on table public.worker_qa_steps to service_role;

create or replace function public.request_worker_qa_run(
  p_scenario text,
  p_repetitions integer default 10
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_run_id uuid;
  v_iteration integer;
begin
  if p_scenario is null or p_scenario not in (
    'progression_target_normal',
    'quest_generation_normal',
    'search',
    'composer_recovery',
    'full_chain_normal'
  ) then
    raise exception 'Unsupported Worker QA scenario: %', coalesce(p_scenario, '<null>');
  end if;
  if p_repetitions is null or p_repetitions < 1 or p_repetitions > 50 then
    raise exception 'Worker QA repetitions must be between 1 and 50';
  end if;

  insert into public.worker_qa_runs(scenario, repetitions, fixture_version)
  values (p_scenario, p_repetitions, 'worker-qa.v1')
  returning id into v_run_id;

  for v_iteration in 1..p_repetitions loop
    insert into public.worker_qa_iterations(run_id, iteration_no)
    values (v_run_id, v_iteration);
  end loop;

  return v_run_id;
end;
$function$;

revoke all on function public.request_worker_qa_run(text, integer) from public, anon, authenticated;
grant execute on function public.request_worker_qa_run(text, integer) to service_role;

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

  -- Production work wins resource priority even though QA uses a separate browser profile.
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
      i.status='queued'
      or (i.status='running' and i.lease_expires_at is not null and i.lease_expires_at < now())
    )
  order by r.created_at, i.iteration_no
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

create or replace function public.refresh_worker_qa_run_summary(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_total integer := 0;
  v_terminal integer := 0;
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
    count(*) filter (where status in ('succeeded','failed','cancelled')),
    count(*) filter (where status='succeeded' and coalesce(validator_passed,true)),
    count(*) filter (where status='failed'),
    count(*) filter (where validator_passed=false),
    coalesce(sum(recovery_count),0),
    round(avg(duration_ms))::integer,
    percentile_disc(0.95) within group (order by duration_ms)::integer,
    count(distinct release_sha) filter (where release_sha is not null)
  into
    v_total,
    v_terminal,
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
        'technicalSuccessCount',v_success,
        'failureCount',v_failure,
        'validatorFailureCount',v_validator_failure,
        'recoveryCount',v_recovery,
        'successRate',case when v_total=0 then 0 else round((v_success::numeric/v_total::numeric)*100,2) end,
        'errorDistribution',v_error_distribution,
        'mixedRelease',v_release_count > 1
      ),
      status=case
        when v_terminal < v_total then 'running'
        when v_failure=0 and v_validator_failure=0 then 'succeeded'
        else 'failed'
      end,
      completed_at=case when v_terminal=v_total then now() else null end,
      updated_at=now()
  where id=p_run_id;
end;
$function$;

revoke all on function public.refresh_worker_qa_run_summary(uuid) from public, anon, authenticated;
grant execute on function public.refresh_worker_qa_run_summary(uuid) to service_role;

create or replace function public.complete_worker_qa_iteration(
  p_iteration_id uuid,
  p_worker_id text,
  p_status text,
  p_duration_ms integer,
  p_validator_passed boolean,
  p_recovery_count integer,
  p_error_code text default null,
  p_error_message text default null,
  p_output jsonb default null,
  p_checkpoints jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_run_id uuid;
begin
  if p_status not in ('succeeded','failed') then
    raise exception 'QA iteration terminal status must be succeeded or failed';
  end if;

  update public.worker_qa_iterations
  set status=p_status,
      duration_ms=greatest(0,coalesce(p_duration_ms,0)),
      validator_passed=p_validator_passed,
      recovery_count=greatest(0,coalesce(p_recovery_count,0)),
      error_code=nullif(left(coalesce(p_error_code,''),120),''),
      error_message=nullif(left(regexp_replace(coalesce(p_error_message,''),'[\r\n\t]+',' ','g'),500),''),
      output=p_output,
      checkpoints=coalesce(p_checkpoints,'[]'::jsonb),
      lease_expires_at=null,
      completed_at=now(),
      updated_at=now()
  where id=p_iteration_id
    and status='running'
    and worker_id=p_worker_id
  returning run_id into v_run_id;

  if v_run_id is null then
    raise exception 'QA iteration is not owned by this worker';
  end if;

  perform public.refresh_worker_qa_run_summary(v_run_id);
end;
$function$;

revoke all on function public.complete_worker_qa_iteration(uuid,text,text,integer,boolean,integer,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.complete_worker_qa_iteration(uuid,text,text,integer,boolean,integer,text,text,jsonb,jsonb) to service_role;

create or replace function public.cancel_worker_qa_run(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_changed boolean := false;
begin
  update public.worker_qa_runs
  set status='cancelled', completed_at=now(), updated_at=now()
  where id=p_run_id and status in ('queued','running');
  v_changed := found;

  if v_changed then
    update public.worker_qa_iterations
    set status='cancelled', completed_at=now(), lease_expires_at=null, updated_at=now()
    where run_id=p_run_id and status='queued';
  end if;

  return v_changed;
end;
$function$;

revoke all on function public.cancel_worker_qa_run(uuid) from public, anon, authenticated;
grant execute on function public.cancel_worker_qa_run(uuid) to service_role;

create or replace function public.get_worker_qa_run(p_run_id uuid)
returns jsonb
language sql
security definer
set search_path=''
as $function$
  select jsonb_build_object(
    'run',to_jsonb(r),
    'iterations',coalesce((
      select jsonb_agg(to_jsonb(i) order by i.iteration_no)
      from public.worker_qa_iterations i
      where i.run_id=r.id
    ),'[]'::jsonb),
    'steps',coalesce((
      select jsonb_agg(to_jsonb(s) order by i.iteration_no,s.worker_attempt,s.step_order)
      from public.worker_qa_steps s
      join public.worker_qa_iterations i on i.id=s.iteration_id
      where s.run_id=r.id
    ),'[]'::jsonb)
  )
  from public.worker_qa_runs r
  where r.id=p_run_id;
$function$;

revoke all on function public.get_worker_qa_run(uuid) from public, anon, authenticated;
grant execute on function public.get_worker_qa_run(uuid) to service_role;

commit;
