-- Quest revision statuses must not be mutable through direct authenticated table updates.
-- The owner-scoped completion RPC remains the only browser mutation surface for quest completion.

revoke update (status, completed_at) on table public.daily_quests from authenticated;

create or replace function public.set_daily_quest_completion(p_quest_id uuid,p_completed boolean)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user_id uuid:=auth.uid();
  v_status text;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  select status into v_status
  from public.daily_quests
  where id=p_quest_id and user_id=v_user_id
  for update;

  if v_status is null then
    raise exception 'Quest not found for authenticated player' using errcode='42501';
  end if;

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
    on conflict(quest_id) do update
      set outcome='completed',recorded_at=now();
  else
    delete from public.quest_results
    where user_id=v_user_id and quest_id=p_quest_id;
  end if;
end;
$$;

revoke execute on function public.set_daily_quest_completion(uuid,boolean) from public, anon;
grant execute on function public.set_daily_quest_completion(uuid,boolean) to authenticated, service_role;
