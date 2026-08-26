begin;

create or replace function public.is_system_transport_recovery_code(p_error_code text)
returns boolean
language sql
immutable
set search_path=''
as $function$
  select coalesce(p_error_code,'') = any(array[
    -- Legacy transport codes remain recognized for jobs created before this rollout.
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
    -- Granular browser invariant codes.
    'page_not_ready',
    'temporary_chat_not_active',
    'composer_not_editable',
    'tool_state_invalid',
    'composer_fill_failed',
    -- Existing post-submit / attachment transport failures.
    'generation_timeout',
    'generation_finish_timeout',
    'transient_transport_error',
    'attachment_download_failed',
    'attachment_upload_unavailable',
    'attachment_upload_timeout'
  ]::text[]);
$function$;

revoke all on function public.is_system_transport_recovery_code(text) from public, anon, authenticated;
grant execute on function public.is_system_transport_recovery_code(text) to service_role;

create or replace function public.claim_ai_inference_job(p_worker_id text, p_lease_seconds integer default 300)
returns setof public.ai_inference_jobs
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_recovery_job public.ai_inference_jobs;
  v_model_recovery_count integer := 0;
  v_transport_recovery_count integer := 0;
  v_is_transport_recovery boolean := false;
begin
  if coalesce(btrim(p_worker_id),'')='' then
    raise exception 'worker id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 1800 then
    raise exception 'lease must be between 30 and 1800 seconds';
  end if;

  select * into v_recovery_job
  from public.ai_inference_jobs j
  where j.status='failed'
    and j.operation='progression_cycle'
    and j.updated_at >= now() - interval '24 hours'
    and not exists(
      select 1 from public.quest_batches b
      where b.user_id=j.user_id
        and b.quest_date=j.target_date
        and b.status='generated'
    )
    and (
      (
        j.error_code in ('model_output_invalid','inference_failed')
        and case
          when coalesce(j.result_summary->>'systemRecoveryCount','') ~ '^\d+$'
            then (j.result_summary->>'systemRecoveryCount')::integer
          else 0
        end < 1
      )
      or
      (
        public.is_system_transport_recovery_code(j.error_code)
        and case
          when coalesce(j.result_summary->>'systemTransportRecoveryCount','') ~ '^\d+$'
            then (j.result_summary->>'systemTransportRecoveryCount')::integer
          else 0
        end < 1
      )
    )
  order by j.updated_at asc
  for update skip locked
  limit 1;

  if found then
    if coalesce(v_recovery_job.result_summary->>'systemRecoveryCount','') ~ '^\d+$' then
      v_model_recovery_count := (v_recovery_job.result_summary->>'systemRecoveryCount')::integer;
    end if;
    if coalesce(v_recovery_job.result_summary->>'systemTransportRecoveryCount','') ~ '^\d+$' then
      v_transport_recovery_count := (v_recovery_job.result_summary->>'systemTransportRecoveryCount')::integer;
    end if;

    v_is_transport_recovery := public.is_system_transport_recovery_code(v_recovery_job.error_code);

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
        result_summary=coalesce(result_summary,'{}'::jsonb) ||
          case
            when v_is_transport_recovery then jsonb_build_object(
              'systemTransportRecoveryCount',v_transport_recovery_count+1,
              'systemTransportRecoveryReason',coalesce(v_recovery_job.error_code,'transport_failure'),
              'systemTransportRecoveredAt',now()
            )
            else jsonb_build_object(
              'systemRecoveryCount',v_model_recovery_count+1,
              'systemRecoveryReason',coalesce(v_recovery_job.error_code,'internal_failure'),
              'systemRecoveredAt',now()
            )
          end,
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
        public.is_system_transport_recovery_code(v_job.error_code)
        and v_transport_recovery_count < 1
      );
  end if;

  return v_status || jsonb_build_object('recoveryAvailable',v_recovery_available);
end;
$function$;

revoke all on function public.get_player_workflow_status_v2(date) from public, anon;
grant execute on function public.get_player_workflow_status_v2(date) to authenticated;

commit;
