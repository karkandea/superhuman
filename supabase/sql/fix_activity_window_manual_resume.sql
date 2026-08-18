-- Ensure an explicit owner-requested progression retry can recover every incomplete stage,
-- including batch materiality that already persisted but still awaits a System Interrupt.

create or replace function public.request_progression_cycle(p_target_date date)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_job public.ai_inference_jobs;
  v_has_quests boolean;
  v_has_pending_raw boolean;
  v_has_pending_materiality boolean;
  v_has_unresolved_interrupt boolean;
  v_has_pending_progression boolean;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_target_date is null then raise exception 'target date is required'; end if;
  if not exists (select 1 from public.users where id = v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode = '42501';
  end if;

  select exists(
    select 1 from public.daily_quests where user_id=v_user_id and quest_date=p_target_date
  ) into v_has_quests;

  select exists(
    select 1 from public.knowledge_entries
    where user_id=v_user_id and processing_status in ('pending','failed')
  ) into v_has_pending_raw;

  select exists(
    select 1 from public.knowledge_entries
    where user_id=v_user_id
      and processing_status='processed'
      and materiality_status in ('pending','failed')
  ) into v_has_pending_materiality;

  select exists(
    select 1
    from public.materiality_assessments a
    where a.user_id=v_user_id
      and a.target_date=p_target_date
      and a.disposition in ('suggest','auto_interrupt')
      and not exists (
        select 1 from public.quest_interrupts i where i.assessment_id=a.id
      )
  ) into v_has_unresolved_interrupt;

  v_has_pending_progression := v_has_pending_raw or v_has_pending_materiality or v_has_unresolved_interrupt;

  insert into public.ai_inference_jobs(
    user_id,operation,target_date,status,completed_at,activity_window_started_at,window_cutoff_at
  ) values (
    v_user_id,'progression_cycle',p_target_date,
    case when v_has_quests and not v_has_pending_progression then 'succeeded' else 'queued' end,
    case when v_has_quests and not v_has_pending_progression then now() else null end,
    case when v_has_pending_progression then now() else null end,
    null
  )
  on conflict (user_id,operation,target_date) do update
  set status = case
        when public.ai_inference_jobs.status='running' then 'running'
        when v_has_quests and not v_has_pending_progression then 'succeeded'
        else 'queued' end,
      rerun_requested = case
        when public.ai_inference_jobs.status='running' and v_has_pending_progression then true
        else false end,
      correlation_id = case
        when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.correlation_id
        else gen_random_uuid() end,
      attempt_count = case
        when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.attempt_count
        else 0 end,
      available_at = case
        when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.available_at
        else now() end,
      lease_expires_at = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.lease_expires_at else null end,
      worker_id = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.worker_id else null end,
      provider_id = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_id else null end,
      provider_conversation_refs = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_conversation_refs else '[]'::jsonb end,
      result_summary = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.result_summary else '{}'::jsonb end,
      error_code = null,
      error_message = null,
      started_at = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.started_at else null end,
      completed_at = case
        when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.completed_at
        when v_has_quests and not v_has_pending_progression then now()
        else null end,
      activity_window_started_at = case
        when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.activity_window_started_at
        when v_has_pending_progression then now()
        else null end,
      window_cutoff_at = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.window_cutoff_at else null end,
      updated_at = now()
  returning * into v_job;

  return v_job;
end;
$$;

revoke execute on function public.request_progression_cycle(date) from public, anon;
grant execute on function public.request_progression_cycle(date) to authenticated, service_role;
