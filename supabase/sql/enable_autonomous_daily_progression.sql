begin;

-- Daily progression is System-owned. A ready player no longer needs to acknowledge
-- a normal day before the first plan can start. The operator is idempotent and
-- deliberately does not revive failed/blocked jobs; recovery ownership remains
-- with the bounded recovery layer.
create or replace function public.ensure_daily_progression_operator(
  p_user_id uuid,
  p_target_date date
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_context_created boolean := false;
  v_job_created boolean := false;
  v_job_resumed boolean := false;
  v_has_final_plan boolean := false;
  v_inserted integer := 0;
begin
  if p_user_id is null then raise exception 'user id is required'; end if;
  if p_target_date is null then raise exception 'target date is required'; end if;
  if not exists(
    select 1 from public.player_initializations
    where user_id=p_user_id and readiness='ready'
  ) then
    return jsonb_build_object('skipped',true,'reason','initialization_not_ready');
  end if;

  insert into public.daily_contexts(user_id,context_date,mode,context_text)
  values(p_user_id,p_target_date,'normal','')
  on conflict(user_id,context_date) do nothing;
  get diagnostics v_inserted = row_count;
  v_context_created := v_inserted = 1;

  select exists(
    select 1 from public.quest_batches
    where user_id=p_user_id and quest_date=p_target_date and status='generated'
  ) into v_has_final_plan;

  if v_has_final_plan then
    return jsonb_build_object(
      'contextCreated',v_context_created,
      'jobCreated',false,
      'jobResumed',false,
      'finalPlan',true
    );
  end if;

  insert into public.ai_inference_jobs(
    user_id,operation,target_date,status,available_at,activity_window_started_at,window_cutoff_at
  ) values (
    p_user_id,'progression_cycle',p_target_date,'queued',now(),null,null
  )
  on conflict(user_id,operation,target_date) do nothing;
  get diagnostics v_inserted = row_count;
  v_job_created := v_inserted = 1;

  select * into v_job
  from public.ai_inference_jobs
  where user_id=p_user_id and operation='progression_cycle' and target_date=p_target_date
  for update;

  if not found then
    raise exception 'Daily progression job could not be ensured';
  end if;

  -- A knowledge update can legitimately finish before a Daily Context exists and
  -- leave the job in succeeded/awaiting_context. Once System supplies the normal
  -- default, resume exactly that waiting lifecycle once. Do not touch other
  -- succeeded jobs or any failed/blocked/recovery state.
  if not v_job_created
     and v_job.status='succeeded'
     and coalesce(v_job.result_summary->>'awaitingDailyContext','false')='true' then
    update public.ai_inference_jobs
    set status='queued',
        correlation_id=gen_random_uuid(),
        attempt_count=0,
        available_at=now(),
        lease_expires_at=null,
        worker_id=null,
        provider_id=null,
        provider_conversation_refs='[]'::jsonb,
        error_code=null,
        error_message=null,
        rerun_requested=false,
        started_at=null,
        completed_at=null,
        activity_window_started_at=null,
        window_cutoff_at=null,
        result_summary=coalesce(result_summary,'{}'::jsonb) || jsonb_build_object(
          'autoDailyResumedAt',now(),
          'awaitingDailyContext',false
        ),
        updated_at=now()
    where id=v_job.id
    returning * into v_job;
    v_job_resumed := true;
  end if;

  return jsonb_build_object(
    'contextCreated',v_context_created,
    'jobCreated',v_job_created,
    'jobResumed',v_job_resumed,
    'finalPlan',false,
    'jobId',v_job.id,
    'jobStatus',v_job.status
  );
end;
$function$;

revoke all on function public.ensure_daily_progression_operator(uuid,date)
  from public, anon, authenticated;
grant execute on function public.ensure_daily_progression_operator(uuid,date)
  to service_role;

-- Safe player-facing self-heal used by Today reads. Repeated calls cannot reset a
-- running/failed/completed lifecycle or create duplicate jobs.
create or replace function public.ensure_daily_progression(p_target_date date)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_timezone text;
  v_local_date date;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_target_date is null then raise exception 'target date is required'; end if;
  if not exists(select 1 from public.users where id=v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode='42501';
  end if;

  select timezone into v_timezone from public.users where id=v_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_local_date := (now() at time zone v_timezone)::date;

  -- Historical reads stay read-only. Opening Today is an explicit freshness signal,
  -- so it may start today's default lifecycle even before the 04:00 background cutover.
  if p_target_date <> v_local_date then
    return jsonb_build_object('skipped',true,'reason','not_current_local_day');
  end if;

  return public.ensure_daily_progression_operator(v_user_id,p_target_date);
end;
$function$;

revoke all on function public.ensure_daily_progression(date) from public, anon;
grant execute on function public.ensure_daily_progression(date) to authenticated;

-- Background autonomy: every 15-minute cron tick now actually ensures today's
-- normal default after the existing 04:00 local-day boundary.
create or replace function public.enqueue_daily_progression_cycles()
returns integer
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_player record;
  v_timezone text;
  v_local_now timestamp;
  v_result jsonb;
  v_started integer := 0;
begin
  for v_player in
    select u.id,u.timezone
    from public.users u
    join public.player_initializations pi on pi.user_id=u.id and pi.readiness='ready'
  loop
    v_timezone := v_player.timezone;
    if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
      v_timezone := 'UTC';
    end if;
    v_local_now := now() at time zone v_timezone;
    if v_local_now::time < time '04:00' then
      continue;
    end if;

    v_result := public.ensure_daily_progression_operator(v_player.id,v_local_now::date);
    if v_result->>'jobCreated'='true' or v_result->>'jobResumed'='true' then
      v_started := v_started + 1;
    end if;
  end loop;
  return v_started;
end;
$function$;

revoke all on function public.enqueue_daily_progression_cycles() from public, anon, authenticated;
grant execute on function public.enqueue_daily_progression_cycles() to service_role;

-- Today status is now also a lifecycle safety-net. Keep all existing bounded
-- recovery semantics; the only new side effect is the idempotent normal default.
create or replace function public.get_player_workflow_status_v2(p_target_date date)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_status jsonb;
  v_job public.ai_inference_jobs;
  v_model_recovery_count integer := 0;
  v_transport_recovery_count integer := 0;
  v_recovery_available boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_target_date is null then
    raise exception 'target date is required';
  end if;

  perform public.ensure_daily_progression(p_target_date);
  v_status := public.get_player_workflow_status(p_target_date);

  if coalesce(v_status->>'turnOwner','')='none'
     and coalesce(v_status->>'activity','') in ('failed','stalled') then
    v_status := v_status || jsonb_build_object('turnOwner','system','canStart',false);
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where user_id=v_user_id
    and operation='progression_cycle'
    and target_date=p_target_date;

  if found and v_job.status='failed' then
    if coalesce(v_job.result_summary->>'systemRecoveryCount','') ~ '^\d+$' then
      v_model_recovery_count := (v_job.result_summary->>'systemRecoveryCount')::integer;
    end if;
    if coalesce(v_job.result_summary->>'systemTransportRecoveryCount','') ~ '^\d+$' then
      v_transport_recovery_count := (v_job.result_summary->>'systemTransportRecoveryCount')::integer;
    end if;

    v_recovery_available :=
      (
        v_job.error_code in ('model_output_invalid','inference_failed')
        and v_model_recovery_count < 1
      )
      or
      (
        v_job.error_code in (
          'pre_submission_state_invalid',
          'composer_fill_timeout',
          'composer_fill_unverified',
          'composer_not_found',
          'composer_send_unverified',
          'chatgpt_page_invalid',
          'browser_challenge',
          'temporary_chat_unverified',
          'web_search_unavailable',
          'web_search_activation_unverified',
          'generation_timeout',
          'generation_finish_timeout',
          'transient_transport_error',
          'attachment_download_failed',
          'attachment_upload_unavailable',
          'attachment_upload_timeout'
        )
        and v_transport_recovery_count < 1
      );
  end if;

  return v_status || jsonb_build_object('recoveryAvailable',v_recovery_available);
end;
$function$;

revoke all on function public.get_player_workflow_status_v2(date) from public, anon;
grant execute on function public.get_player_workflow_status_v2(date) to authenticated;

commit;
