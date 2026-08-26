begin;

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
  v_traffic public.chatgpt_traffic_state;
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

  if exists (
    select 1 from public.ai_inference_jobs j
    where j.status='running'
       or (j.status='queued' and j.available_at <= now() and j.attempt_count < j.max_attempts)
  ) then
    return;
  end if;

  select * into v_traffic
  from public.chatgpt_traffic_state
  where singleton=true;

  if (v_traffic.cooldown_until is not null and v_traffic.cooldown_until > now())
     or (v_traffic.qa_cooldown_until is not null and v_traffic.qa_cooldown_until > now())
     or (v_traffic.qa_next_allowed_at is not null and v_traffic.qa_next_allowed_at > now())
     or (
       v_traffic.active_holder is not null
       and v_traffic.lease_expires_at is not null
       and v_traffic.lease_expires_at > now()
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

revoke all on function public.claim_worker_qa_iteration(text,text,integer) from public, anon, authenticated;
grant execute on function public.claim_worker_qa_iteration(text,text,integer) to service_role;

commit;
