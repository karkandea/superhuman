begin;

create or replace function public.ensure_player_brief_bootstrap_internal(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user public.users%rowtype;
  v_existing_id uuid;
  v_version integer;
  v_brief_id uuid;
begin
  if p_user_id is null then raise exception 'player id is required'; end if;
  select * into v_user from public.users where id=p_user_id;
  if not found then raise exception 'Unknown player'; end if;

  select id into v_existing_id
  from public.player_briefs
  where user_id=p_user_id and is_current
  limit 1;
  if found then return v_existing_id; end if;

  select coalesce(max(version),0)+1 into v_version
  from public.player_briefs
  where user_id=p_user_id;

  insert into public.player_briefs(
    user_id,version,schema_version,brief,is_current,reason
  ) values (
    p_user_id,
    v_version,
    'player-brief.v1',
    jsonb_build_object(
      'schemaVersion','player-brief.v1',
      'generatedAt',now(),
      'player',jsonb_build_object(
        'id',v_user.id,
        'name',v_user.name,
        'timezone',v_user.timezone
      ),
      'activeUnderstandingIds','[]'::jsonb,
      'highlights','[]'::jsonb,
      'sections',jsonb_build_object(
        'goals','[]'::jsonb,
        'obstacles','[]'::jsonb,
        'opportunities','[]'::jsonb,
        'constraints','[]'::jsonb,
        'preferences','[]'::jsonb,
        'relationships','[]'::jsonb,
        'events','[]'::jsonb,
        'priorities','[]'::jsonb
      ),
      'activeSignals','[]'::jsonb,
      'counts',jsonb_build_object(
        'activeUnderstanding',0,
        'activeSignals',0,
        'briefUnderstanding',0,
        'briefSignals',0
      )
    ),
    true,
    'player_initialization_bootstrap'
  ) returning id into v_brief_id;

  return v_brief_id;
end;
$function$;

revoke all on function public.ensure_player_brief_bootstrap_internal(uuid) from public, anon, authenticated;
grant execute on function public.ensure_player_brief_bootstrap_internal(uuid) to service_role;

create or replace function public.ensure_player_initialization()
returns public.player_initializations
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_state public.player_initializations;
  v_progressed boolean := false;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not exists(select 1 from public.users where id=v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode='42501';
  end if;

  perform public.ensure_player_brief_bootstrap_internal(v_user_id);

  select (
    exists(select 1 from public.daily_quests q where q.user_id=v_user_id)
    or exists(select 1 from public.derived_understanding d where d.user_id=v_user_id)
  ) into v_progressed;

  insert into public.player_initializations(
    user_id,stage,readiness,readiness_dimensions,readiness_reason,ready_at
  ) values (
    v_user_id,
    case when v_progressed then 'ready' else 'initializing' end,
    case when v_progressed then 'ready' else 'ask' end,
    case when v_progressed then jsonb_build_object(
      'direction',jsonb_build_object('status','sufficient','confidence',1,'summary','Existing player progression predates initialization rollout.'),
      'current_state',jsonb_build_object('status','sufficient','confidence',1,'summary','Existing player progression predates initialization rollout.'),
      'bottleneck_opportunity',jsonb_build_object('status','sufficient','confidence',1,'summary','Existing player progression predates initialization rollout.'),
      'capacity_constraints',jsonb_build_object('status','sufficient','confidence',1,'summary','Existing player progression predates initialization rollout.')
    ) else '{}'::jsonb end,
    case when v_progressed then 'Existing progressed player preserved as READY during initialization rollout.' else null end,
    case when v_progressed then now() else null end
  ) on conflict(user_id) do nothing;

  select * into v_state from public.player_initializations where user_id=v_user_id;

  if v_state.readiness <> 'ready' then
    insert into public.player_initialization_questions(
      user_id,origin,question_key,dimension,prompt,reason,priority,sequence,calibration_version
    ) values
      (v_user_id,'basic','life_context','current_state','Sekarang lo lagi ada di fase hidup seperti apa?','Establish broad current life state without assuming which domain matters.',5,10,0),
      (v_user_id,'basic','primary_activity','current_state','Hari-hari lo sekarang paling banyak diisi aktivitas atau peran apa?','Establish the player current operating context without inferring a goal.',5,20,0),
      (v_user_id,'basic','schedule_structure','capacity_constraints','Pola waktu lo biasanya kayak gimana dalam seminggu?','Establish realistic capacity and recurring structure.',4,30,0),
      (v_user_id,'basic','current_direction','direction','Kalau beberapa minggu ke depan hidup lo maju satu langkah, bagian apa yang paling pengen lo gerakkan?','Establish explicit direction rather than inferring it from identity or role.',5,40,0),
      (v_user_id,'basic','major_constraint','bottleneck_opportunity','Apa yang paling sering nahan, bikin susah, atau justru jadi peluang terbesar buat langkah itu sekarang?','Establish the likely leverage point or blocker for progression.',5,50,0)
    on conflict(user_id,question_key) where origin='basic' do nothing;
  end if;

  select * into v_state from public.player_initializations where user_id=v_user_id;
  return v_state;
end;
$function$;

revoke all on function public.ensure_player_initialization() from public;
grant execute on function public.ensure_player_initialization() to authenticated;

commit;
