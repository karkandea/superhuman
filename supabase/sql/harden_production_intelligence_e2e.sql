begin;

-- Worker-side initialization reasoning reads bounded initialization state directly.
-- Keep mutations behind the existing service-only persistence RPC.
grant select on table public.player_initializations to service_role;
grant select on table public.player_initialization_questions to service_role;

create or replace function public.record_daily_quest_result(
  p_quest_id uuid,
  p_outcome text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_quest_date date;
  v_note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_outcome not in ('completed','partial','skipped','failed') then
    raise exception 'Unsupported quest outcome';
  end if;
  if v_note is not null and octet_length(convert_to(v_note,'UTF8')) > 2000 then
    raise exception 'Quest result note must be 2 KB or smaller';
  end if;

  select status,quest_date into v_status,v_quest_date
  from public.daily_quests
  where id=p_quest_id and user_id=v_user_id
  for update;

  if v_status is null then
    raise exception 'Quest not found for authenticated player' using errcode='42501';
  end if;
  if v_status in ('deferred','cancelled','replaced') then
    raise exception 'Interrupted historical quest cannot receive a direct result';
  end if;

  update public.daily_quests
  set status=p_outcome,
      completed_at=case when p_outcome='completed' then now() else null end
  where id=p_quest_id and user_id=v_user_id;

  insert into public.quest_results(user_id,quest_id,outcome,note,recorded_at)
  values(v_user_id,p_quest_id,p_outcome,v_note,now())
  on conflict(quest_id) do update
  set outcome=excluded.outcome,
      note=excluded.note,
      recorded_at=now();

  delete from public.quest_response_events
  where user_id=v_user_id and quest_id=p_quest_id;

  insert into public.ai_inference_jobs(
    user_id,operation,target_date,status,completed_at,activity_window_started_at,window_cutoff_at
  ) values (
    v_user_id,'progression_cycle',v_quest_date,'queued',null,now(),null
  )
  on conflict(user_id,operation,target_date) do update
  set status=case when public.ai_inference_jobs.status='running' then 'running' else 'queued' end,
      rerun_requested=case when public.ai_inference_jobs.status='running' then true else false end,
      correlation_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.correlation_id else gen_random_uuid() end,
      attempt_count=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.attempt_count else 0 end,
      available_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.available_at else now() end,
      lease_expires_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.lease_expires_at else null end,
      worker_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.worker_id else null end,
      provider_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_id else null end,
      provider_conversation_refs=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_conversation_refs else '[]'::jsonb end,
      result_summary=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.result_summary else '{}'::jsonb end,
      error_code=null,
      error_message=null,
      started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.started_at else null end,
      completed_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.completed_at else null end,
      activity_window_started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.activity_window_started_at else now() end,
      window_cutoff_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.window_cutoff_at else null end,
      updated_at=now();
end;
$function$;

revoke all on function public.record_daily_quest_result(uuid,text,text) from public;
grant execute on function public.record_daily_quest_result(uuid,text,text) to authenticated;

create or replace function public.set_daily_quest_completion(
  p_quest_id uuid,
  p_completed boolean
)
returns void
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_quest_date date;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select status,quest_date into v_status,v_quest_date
  from public.daily_quests
  where id=p_quest_id and user_id=v_user_id
  for update;
  if v_status is null then raise exception 'Quest not found for authenticated player' using errcode='42501'; end if;
  if v_status in ('deferred','cancelled','replaced','skipped','failed') then
    raise exception 'Historical or interrupted quest cannot be toggled';
  end if;

  update public.daily_quests
  set status=case when p_completed then 'completed' else 'pending' end,
      completed_at=case when p_completed then now() else null end
  where id=p_quest_id and user_id=v_user_id;

  if p_completed then
    insert into public.quest_results(user_id,quest_id,outcome,recorded_at)
    values(v_user_id,p_quest_id,'completed',now())
    on conflict(quest_id) do update set outcome='completed',recorded_at=now();
  else
    delete from public.quest_results where user_id=v_user_id and quest_id=p_quest_id;
  end if;
  delete from public.quest_response_events where user_id=v_user_id and quest_id=p_quest_id;

  insert into public.ai_inference_jobs(
    user_id,operation,target_date,status,completed_at,activity_window_started_at,window_cutoff_at
  ) values (
    v_user_id,'progression_cycle',v_quest_date,'queued',null,now(),null
  )
  on conflict(user_id,operation,target_date) do update
  set status=case when public.ai_inference_jobs.status='running' then 'running' else 'queued' end,
      rerun_requested=case when public.ai_inference_jobs.status='running' then true else false end,
      correlation_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.correlation_id else gen_random_uuid() end,
      attempt_count=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.attempt_count else 0 end,
      available_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.available_at else now() end,
      lease_expires_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.lease_expires_at else null end,
      worker_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.worker_id else null end,
      provider_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_id else null end,
      provider_conversation_refs=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_conversation_refs else '[]'::jsonb end,
      result_summary=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.result_summary else '{}'::jsonb end,
      error_code=null,
      error_message=null,
      started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.started_at else null end,
      completed_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.completed_at else null end,
      activity_window_started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.activity_window_started_at else now() end,
      window_cutoff_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.window_cutoff_at else null end,
      updated_at=now();
end;
$function$;

revoke all on function public.set_daily_quest_completion(uuid,boolean) from public;
grant execute on function public.set_daily_quest_completion(uuid,boolean) to authenticated, service_role;

commit;
