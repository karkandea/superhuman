-- Keep player-facing progression state aligned with the durable inference job and
-- expose a bounded recovery path only for transport/browser failures.

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
  v_recoverable_codes constant text[] := array[
    'generation_timeout',
    'generation_finish_timeout',
    'generation_empty',
    'transient_transport_error',
    'stale_player_brief',
    'browser_challenge',
    'browser_start_failed',
    'browser_connect_failed',
    'browser_context_missing',
    'chatgpt_page_invalid',
    'pre_submission_state_invalid',
    'composer_not_found',
    'composer_fill_timeout',
    'composer_fill_unverified',
    'composer_send_unavailable',
    'composer_send_timeout',
    'composer_send_unverified',
    'attachment_download_failed',
    'attachment_upload_unavailable',
    'attachment_upload_timeout',
    'temporary_chat_unverified',
    'web_search_unavailable',
    'web_search_activation_unverified'
  ];
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  v_status := public.get_player_workflow_status(p_target_date);

  if coalesce(v_status->>'phase','') <> 'stopped'
     or coalesce(v_status->>'activity','') <> 'failed' then
    return v_status || jsonb_build_object('recoveryAvailable', false);
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where user_id=v_user_id
    and operation='progression_cycle'
    and target_date=p_target_date;

  if found
     and v_job.status='failed'
     and v_job.error_code = any(v_recoverable_codes) then
    return v_status || jsonb_build_object(
      'canStart', true,
      'recoveryAvailable', true
    );
  end if;

  return v_status || jsonb_build_object('recoveryAvailable', false);
end;
$function$;

revoke all on function public.get_player_workflow_status_v2(date) from public, anon;
grant execute on function public.get_player_workflow_status_v2(date) to authenticated, service_role;

create or replace function public.sync_progression_session_with_job_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status in ('failed','blocked_auth','paused_rate_limit') then
    update public.progression_sessions
    set state='stopped',
        state_metadata=coalesce(state_metadata,'{}'::jsonb) || jsonb_build_object(
          'jobStatus',new.status,
          'errorCode',new.error_code,
          'jobUpdatedAt',new.updated_at
        ),
        updated_at=now()
    where current_job_id=new.id
      and status='active'
      and state not in ('quest_ready','waiting');
  elsif new.status='queued'
        and old.status in ('failed','blocked_auth','paused_rate_limit') then
    update public.progression_sessions
    set state='understanding',
        state_metadata=coalesce(state_metadata,'{}'::jsonb) || jsonb_build_object(
          'jobStatus','queued',
          'recoveredFrom',old.status,
          'errorCode',null,
          'jobUpdatedAt',new.updated_at
        ),
        updated_at=now()
    where current_job_id=new.id
      and status='active';
  end if;

  return new;
end;
$function$;

revoke all on function public.sync_progression_session_with_job_lifecycle() from public, anon, authenticated, service_role;

drop trigger if exists ai_inference_job_sync_progression_session on public.ai_inference_jobs;
create trigger ai_inference_job_sync_progression_session
after update of status,error_code,updated_at on public.ai_inference_jobs
for each row
when (old.status is distinct from new.status or old.error_code is distinct from new.error_code)
execute function public.sync_progression_session_with_job_lifecycle();
