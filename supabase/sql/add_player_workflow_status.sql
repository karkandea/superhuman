-- Canonical player-facing workflow truth for Today.
-- Internal queue/step names stay private; the UI receives only safe workflow semantics.

create or replace function public.get_player_workflow_status(p_target_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_job public.ai_inference_jobs;
  v_batch public.quest_batches;
  v_step public.progression_run_steps;
  v_has_context boolean := false;
  v_has_map boolean := false;
  v_has_target boolean := false;
  v_pending_raw boolean := false;
  v_actionable_quests integer := 0;
  v_total_quests integer := 0;
  v_no_quest boolean := false;
  v_turn text := 'none';
  v_phase text := 'stopped';
  v_activity text := 'idle';
  v_active_since timestamptz;
  v_eta_operation text;
  v_eta_samples integer := 0;
  v_eta_p50 integer;
  v_eta_p80 integer;
  v_longer_than_usual boolean := false;
  v_can_start boolean := false;
  v_now timestamptz := now();
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

  select exists(
    select 1 from public.daily_contexts
    where user_id=v_user_id and context_date=p_target_date
  ) into v_has_context;

  select exists(
    select 1 from public.progression_maps
    where user_id=v_user_id and is_current
  ) into v_has_map;

  select exists(
    select 1 from public.progression_targets
    where user_id=v_user_id and target_date=p_target_date
  ) into v_has_target;

  select exists(
    select 1 from public.knowledge_entries
    where user_id=v_user_id and processing_status in ('pending','failed')
  ) into v_pending_raw;

  select count(*), count(*) filter (where status in ('pending','partial'))
  into v_total_quests, v_actionable_quests
  from public.daily_quests
  where user_id=v_user_id and quest_date=p_target_date;

  select * into v_batch
  from public.quest_batches
  where user_id=v_user_id and quest_date=p_target_date;
  if found and v_batch.status='generated' then
    v_no_quest := coalesce((v_batch.generation_metadata->>'noQuest')::boolean,false);
    if v_actionable_quests > 0 then
      v_turn := 'player';
      v_phase := 'quest_ready';
      v_activity := 'ready';
    else
      v_turn := 'none';
      v_phase := 'no_action';
      v_activity := 'ready';
    end if;

    return jsonb_build_object(
      'targetDate',p_target_date,
      'turnOwner',v_turn,
      'phase',v_phase,
      'activity',v_activity,
      'actionableQuestCount',v_actionable_quests,
      'questCount',v_total_quests,
      'noQuest',v_no_quest,
      'canStart',false,
      'updatedAt',coalesce(v_batch.completed_at,v_batch.created_at)
    );
  end if;

  if not v_has_context then
    return jsonb_build_object(
      'targetDate',p_target_date,
      'turnOwner','player',
      'phase','needs_checkin',
      'activity','idle',
      'actionableQuestCount',0,
      'questCount',v_total_quests,
      'noQuest',false,
      'canStart',false,
      'updatedAt',v_now
    );
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where user_id=v_user_id and operation='progression_cycle' and target_date=p_target_date;

  if not found then
    return jsonb_build_object(
      'targetDate',p_target_date,
      'turnOwner','none',
      'phase','stopped',
      'activity','idle',
      'actionableQuestCount',0,
      'questCount',v_total_quests,
      'noQuest',false,
      'canStart',true,
      'updatedAt',v_now
    );
  end if;

  if v_job.status='failed' and v_job.error_code='insufficient_context' then
    return jsonb_build_object(
      'targetDate',p_target_date,
      'turnOwner','player',
      'phase','needs_more_context',
      'activity','failed',
      'actionableQuestCount',0,
      'questCount',v_total_quests,
      'noQuest',false,
      'canStart',false,
      'updatedAt',v_job.updated_at
    );
  end if;

  if v_job.status in ('failed','blocked_auth','paused_rate_limit') then
    return jsonb_build_object(
      'targetDate',p_target_date,
      'turnOwner','none',
      'phase','stopped',
      'activity','failed',
      'actionableQuestCount',0,
      'questCount',v_total_quests,
      'noQuest',false,
      'canStart',false,
      'updatedAt',v_job.updated_at
    );
  end if;

  if v_job.status='succeeded' then
    return jsonb_build_object(
      'targetDate',p_target_date,
      'turnOwner','none',
      'phase','stopped',
      'activity','failed',
      'actionableQuestCount',0,
      'questCount',v_total_quests,
      'noQuest',false,
      'canStart',false,
      'updatedAt',coalesce(v_job.completed_at,v_job.updated_at)
    );
  end if;

  -- A queue item only counts as active while it is plausibly claimable.
  -- This is a liveness guard, not an ETA: a due item unclaimed for 90 seconds is no longer presented as "working".
  if v_job.status='queued' and v_job.available_at <= v_now - interval '90 seconds' then
    return jsonb_build_object(
      'targetDate',p_target_date,
      'turnOwner','none',
      'phase','stopped',
      'activity','stalled',
      'actionableQuestCount',0,
      'questCount',v_total_quests,
      'noQuest',false,
      'canStart',false,
      'updatedAt',v_job.updated_at
    );
  end if;

  -- A running row without a live lease is recoverable by the worker, but it is not currently running.
  if v_job.status='running' and (v_job.lease_expires_at is null or v_job.lease_expires_at <= v_now) then
    return jsonb_build_object(
      'targetDate',p_target_date,
      'turnOwner','none',
      'phase','stopped',
      'activity','stalled',
      'actionableQuestCount',0,
      'questCount',v_total_quests,
      'noQuest',false,
      'canStart',false,
      'updatedAt',v_job.updated_at
    );
  end if;

  -- Active queue/running state. Prefer the current durable step when available.
  select * into v_step
  from public.progression_run_steps
  where job_id=v_job.id and status='running'
  order by updated_at desc
  limit 1;

  v_turn := 'system';
  v_activity := case when v_job.status='running' then 'running' else 'queued' end;
  v_active_since := coalesce(v_step.started_at,v_job.started_at,v_job.created_at);

  if v_pending_raw or (found and v_step.step='understanding') then
    v_phase := 'understanding';
  elsif found and v_step.step in ('quest_generation','quest_repair') then
    v_phase := 'preparing_quests';
  elsif v_has_target then
    v_phase := 'preparing_quests';
  elsif found and v_step.step in ('progression_map','progression_map_after_learning','progression_target') then
    v_phase := 'choosing_focus';
  elsif v_has_map then
    v_phase := 'choosing_focus';
  else
    v_phase := 'understanding';
  end if;

  v_eta_operation := case
    when found and v_step.step='quest_repair' then 'quest_repair'
    when v_phase='preparing_quests' then 'quest_generation'
    when found and v_step.step='progression_target' then 'progression_target'
    else null
  end;

  if v_eta_operation is not null then
    select count(*)::integer,
           percentile_cont(0.5) within group(order by latency_ms)::integer,
           percentile_cont(0.8) within group(order by latency_ms)::integer
    into v_eta_samples,v_eta_p50,v_eta_p80
    from public.progression_run_steps
    where step=v_eta_operation and status='succeeded' and latency_ms is not null;

    if v_eta_samples < 5 then
      v_eta_p50 := null;
      v_eta_p80 := null;
    elsif v_active_since is not null and v_eta_p80 is not null then
      v_longer_than_usual := extract(epoch from (v_now-v_active_since))*1000 > v_eta_p80;
    end if;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'targetDate',p_target_date,
    'turnOwner',v_turn,
    'phase',v_phase,
    'activity',v_activity,
    'actionableQuestCount',0,
    'questCount',v_total_quests,
    'noQuest',false,
    'canStart',false,
    'activeSince',v_active_since,
    'etaOperation',v_eta_operation,
    'etaSampleCount',v_eta_samples,
    'etaP50Ms',v_eta_p50,
    'etaP80Ms',v_eta_p80,
    'longerThanUsual',v_longer_than_usual,
    'updatedAt',v_job.updated_at
  ));
end;
$function$;

revoke all on function public.get_player_workflow_status(date) from public, anon;
grant execute on function public.get_player_workflow_status(date) to authenticated, service_role;

-- Explicit operator-only recovery. Player UI never calls this function.
create or replace function public.resume_progression_cycle_operator(
  p_user_id uuid,
  p_target_date date,
  p_reason text default 'operator_recovery'
)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_resume_count integer := 0;
begin
  if p_user_id is null or p_target_date is null then raise exception 'player and target date are required'; end if;
  if exists(
    select 1 from public.quest_batches
    where user_id=p_user_id and quest_date=p_target_date and status='generated'
  ) then
    raise exception 'Daily plan is already finalized';
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where user_id=p_user_id and operation='progression_cycle' and target_date=p_target_date
  for update;
  if not found then raise exception 'Progression job does not exist'; end if;
  if v_job.status not in ('failed','blocked_auth','paused_rate_limit') then
    raise exception 'Only terminal or paused progression jobs can be operator-resumed';
  end if;

  if coalesce(v_job.result_summary->>'operatorResumeCount','') ~ '^\d+$' then
    v_resume_count := (v_job.result_summary->>'operatorResumeCount')::integer;
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
      result_summary=coalesce(result_summary,'{}'::jsonb) || jsonb_build_object(
        'operatorResumeCount',v_resume_count+1,
        'operatorResumeReason',left(coalesce(nullif(btrim(p_reason),''),'operator_recovery'),120),
        'operatorResumedAt',now()
      ),
      updated_at=now()
  where id=v_job.id
  returning * into v_job;

  return v_job;
end;
$function$;

revoke all on function public.resume_progression_cycle_operator(uuid,date,text) from public, anon, authenticated;
grant execute on function public.resume_progression_cycle_operator(uuid,date,text) to service_role;
