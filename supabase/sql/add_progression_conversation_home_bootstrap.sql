begin;

create or replace function public.ensure_player_progression_session(p_target_date date default null)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid:=auth.uid();
  v_timezone text;
  v_target_date date:=p_target_date;
  v_session public.progression_sessions;
  v_created boolean:=false;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not exists(select 1 from public.player_initializations where user_id=v_user_id and readiness='ready') then
    raise exception 'Player initialization is not ready' using errcode='42501';
  end if;
  if v_target_date is null then
    select timezone into v_timezone from public.users where id=v_user_id;
    if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone:='UTC'; end if;
    v_target_date:=(now() at time zone v_timezone)::date;
  end if;

  select * into v_session from public.progression_sessions where user_id=v_user_id and status='active';
  if not found then v_created:=true; end if;
  v_session:=public.ensure_progression_session_operator(v_user_id,v_target_date,null);

  if v_created then
    update public.progression_sessions
    set state='waiting',state_metadata=jsonb_build_object('reason','daily_context'),updated_at=now()
    where id=v_session.id returning * into v_session;

    insert into public.progression_messages(session_id,user_id,actor,message_type,body,metadata,dedupe_key)
    values(
      v_session.id,v_user_id,'system','system_update',
      'Gambaran awal lo udah kebaca. Gue akan cek kondisi hari ini sebelum nentuin langkah pertama.',
      jsonb_build_object('next','daily_context'),
      'home-bootstrap'
    ) on conflict(session_id,dedupe_key) where dedupe_key is not null do nothing;
  end if;

  return jsonb_build_object('id',v_session.id,'title',v_session.title,'kind',v_session.kind,'state',v_session.state,'targetDate',v_session.target_date,'openedAt',v_session.opened_at);
end;
$function$;

revoke all on function public.ensure_player_progression_session(date) from public,anon;
grant execute on function public.ensure_player_progression_session(date) to authenticated;

commit;
