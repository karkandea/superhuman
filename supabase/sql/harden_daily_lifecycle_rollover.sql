begin;

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
  v_has_context boolean := false;
  v_has_quests boolean := false;
  v_recoverable_codes constant text[] := array[
    'generation_timeout','generation_finish_timeout','generation_empty','transient_transport_error','stale_player_brief',
    'browser_challenge','browser_start_failed','browser_connect_failed','browser_context_missing','chatgpt_page_invalid',
    'pre_submission_state_invalid','composer_not_found','composer_fill_timeout','composer_fill_unverified',
    'composer_send_unavailable','composer_send_timeout','composer_send_unverified','attachment_download_failed',
    'attachment_upload_unavailable','attachment_upload_timeout','temporary_chat_unverified','web_search_unavailable',
    'web_search_activation_unverified'
  ];
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_target_date is null then raise exception 'target date is required'; end if;

  -- Safety net: every Today-state read reconciles the canonical progression
  -- session to the requested local day. The operator is idempotent and closes
  -- a completed/waiting prior-day session before creating today's session.
  perform public.ensure_player_progression_session(p_target_date);

  select exists(
    select 1 from public.daily_contexts
    where user_id=v_user_id and context_date=p_target_date
  ) into v_has_context;

  select exists(
    select 1 from public.daily_quests
    where user_id=v_user_id and quest_date=p_target_date
  ) into v_has_quests;

  select * into v_job
  from public.ai_inference_jobs
  where user_id=v_user_id and operation='progression_cycle' and target_date=p_target_date;

  -- If check-in already exists but the lifecycle job is missing (for example
  -- after a sleeping tab, interrupted request, or hydration race), recreate it
  -- through the normal idempotent enqueue path. Do not fabricate Daily Context.
  if v_has_context and not v_has_quests and not found then
    perform public.request_progression_cycle(p_target_date);
  end if;

  v_status := public.get_player_workflow_status(p_target_date);
  if coalesce(v_status->>'phase','') <> 'stopped' or coalesce(v_status->>'activity','') <> 'failed' then
    return v_status || jsonb_build_object('recoveryAvailable',false);
  end if;

  select * into v_job from public.ai_inference_jobs
  where user_id=v_user_id and operation='progression_cycle' and target_date=p_target_date;
  if found and v_job.status='failed' and v_job.error_code = any(v_recoverable_codes) then
    return v_status || jsonb_build_object('canStart',true,'recoveryAvailable',true);
  end if;
  return v_status || jsonb_build_object('recoveryAvailable',false);
end;
$function$;

revoke execute on function public.get_player_workflow_status_v2(date) from public, anon;
grant execute on function public.get_player_workflow_status_v2(date) to authenticated;

commit;
