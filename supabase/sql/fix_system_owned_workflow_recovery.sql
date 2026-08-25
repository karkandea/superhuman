-- Player-facing workflow recovery must never dead-end as failed + turnOwner=none.
-- Status reads are side-effect free. Initial generation is a one-shot idempotent start.
-- Internal model/inference failures get one bounded worker-owned recovery cycle.

-- Safe client entrypoint: create the first progression job once after Daily Context.
-- Repeated/concurrent calls return the existing job unchanged and never reset/requeue it.
create or replace function public.start_progression_cycle_after_checkin(p_target_date date)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_job public.ai_inference_jobs;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_target_date is null then
    raise exception 'target date is required';
  end if;
  if not exists(select 1 from public.users where id=v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode = '42501';
  end if;
  if not exists(
    select 1 from public.daily_contexts
    where user_id=v_user_id and context_date=p_target_date
  ) then
    raise exception 'Daily Context check-in required before first Daily Quest generation';
  end if;
  if exists(
    select 1 from public.quest_batches
    where user_id=v_user_id and quest_date=p_target_date and status='generated'
  ) then
    raise exception 'Daily plan is already finalized';
  end if;

  insert into public.ai_inference_jobs(
    user_id, operation, target_date, status, available_at,
    activity_window_started_at, window_cutoff_at
  )
  values (
    v_user_id, 'progression_cycle', p_target_date, 'queued', now(),
    null, null
  )
  on conflict (user_id, operation, target_date) do nothing;

  select * into v_job
  from public.ai_inference_jobs
  where user_id=v_user_id
    and operation='progression_cycle'
    and target_date=p_target_date;

  if not found then
    raise exception 'Progression job could not be created';
  end if;
  return v_job;
end;
$function$;

revoke all on function public.start_progression_cycle_after_checkin(date) from public, anon;
grant execute on function public.start_progression_cycle_after_checkin(date) to authenticated, service_role;

-- The mutating progression request primitive is server-only. Player clients use the
-- idempotent start_progression_cycle_after_checkin entrypoint above.
revoke all on function public.request_progression_cycle(date) from public, anon, authenticated;
grant execute on function public.request_progression_cycle(date) to service_role;

-- Raw workflow status is an internal primitive. Expose only v2 to player clients so
-- the player-facing turn-owner contract cannot be bypassed.
revoke all on function public.get_player_workflow_status(date) from public, anon, authenticated;
grant execute on function public.get_player_workflow_status(date) to service_role;

-- Canonical player-facing workflow status. This function is intentionally read-only:
-- no session creation, enqueue, retry, or recovery mutation may happen on a status read.
create or replace function public.get_player_workflow_status_v2(p_target_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_status jsonb;
  v_job public.ai_inference_jobs;
  v_system_recovery_count integer := 0;
  v_recovery_available boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_target_date is null then
    raise exception 'target date is required';
  end if;

  v_status := public.get_player_workflow_status(p_target_date);

  -- failed/stalled work without a player action is always owned by System.
  -- `none` is reserved for genuinely completed no-action states.
  if coalesce(v_status->>'turnOwner','')='none'
     and coalesce(v_status->>'activity','') in ('failed','stalled') then
    v_status := v_status || jsonb_build_object(
      'turnOwner','system',
      'canStart',false
    );
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where user_id=v_user_id
    and operation='progression_cycle'
    and target_date=p_target_date;

  if found and v_job.status='failed' then
    if coalesce(v_job.result_summary->>'systemRecoveryCount','') ~ '^\d+$' then
      v_system_recovery_count := (v_job.result_summary->>'systemRecoveryCount')::integer;
    end if;
    v_recovery_available := v_job.error_code in ('model_output_invalid','inference_failed')
      and v_system_recovery_count < 1;
  end if;

  return v_status || jsonb_build_object('recoveryAvailable',v_recovery_available);
end;
$function$;

revoke all on function public.get_player_workflow_status_v2(date) from public, anon;
grant execute on function public.get_player_workflow_status_v2(date) to authenticated, service_role;

-- Worker claim owns bounded autonomous recovery. A recent internal model/inference
-- failure may be re-queued exactly once. This is independent of player status reads.
create or replace function public.claim_ai_inference_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_recovery_job public.ai_inference_jobs;
  v_recovery_count integer := 0;
begin
  if coalesce(btrim(p_worker_id),'')='' then
    raise exception 'worker id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 1800 then
    raise exception 'lease must be between 30 and 1800 seconds';
  end if;

  -- Recover only fresh system-owned terminal failures, once, and never after a
  -- finalized quest batch. Durable progression_run_steps remain intact, so the
  -- worker resumes from the persisted workflow state instead of fabricating state.
  select * into v_recovery_job
  from public.ai_inference_jobs j
  where j.status='failed'
    and j.operation='progression_cycle'
    and j.error_code in ('model_output_invalid','inference_failed')
    and j.updated_at >= now() - interval '24 hours'
    and not exists(
      select 1 from public.quest_batches b
      where b.user_id=j.user_id
        and b.quest_date=j.target_date
        and b.status='generated'
    )
    and case
      when coalesce(j.result_summary->>'systemRecoveryCount','') ~ '^\d+$'
        then (j.result_summary->>'systemRecoveryCount')::integer
      else 0
    end < 1
  order by j.updated_at asc
  for update skip locked
  limit 1;

  if found then
    if coalesce(v_recovery_job.result_summary->>'systemRecoveryCount','') ~ '^\d+$' then
      v_recovery_count := (v_recovery_job.result_summary->>'systemRecoveryCount')::integer;
    end if;

    update public.ai_inference_jobs
    set status='queued',
        correlation_id=gen_random_uuid(),
        attempt_count=0,
        available_at=now(),
        lease_expires_at=null,
        worker_id=null,
        rerun_requested=false,
        error_code=null,
        error_message=null,
        started_at=null,
        completed_at=null,
        activity_window_started_at=now(),
        window_cutoff_at=null,
        result_summary=coalesce(result_summary,'{}'::jsonb) || jsonb_build_object(
          'systemRecoveryCount',v_recovery_count+1,
          'systemRecoveryReason',coalesce(v_recovery_job.error_code,'internal_failure'),
          'systemRecoveredAt',now()
        ),
        updated_at=now()
    where id=v_recovery_job.id;
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where status <> 'paused_rate_limit'
    and attempt_count < max_attempts
    and (
      (status='queued' and available_at<=now())
      or (status='running' and lease_expires_at is not null and lease_expires_at<now())
    )
  order by available_at,created_at
  for update skip locked
  limit 1;

  if not found then return; end if;

  update public.ai_inference_jobs
  set status='running',
      attempt_count=case when v_job.error_code='provider_rate_limited' then attempt_count else attempt_count+1 end,
      worker_id=p_worker_id,
      lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      started_at=coalesce(started_at,now()),
      window_cutoff_at=coalesce(window_cutoff_at,now()),
      activity_window_started_at=case when v_job.window_cutoff_at is null then null else activity_window_started_at end,
      error_code=null,
      error_message=null,
      updated_at=now()
  where id=v_job.id
  returning * into v_job;

  insert into public.ai_inference_attempts(
    job_id,user_id,target_date,attempt_number,worker_id,status,provider_id,started_at
  ) values (
    v_job.id,v_job.user_id,v_job.target_date,v_job.attempt_count,p_worker_id,'running',v_job.provider_id,now()
  );

  return next v_job;
  return;
end;
$function$;

revoke all on function public.claim_ai_inference_job(text,integer) from public, anon, authenticated;
grant execute on function public.claim_ai_inference_job(text,integer) to service_role;
