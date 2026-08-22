begin;

-- Refresh the still-unanswered basic onboarding set in place so existing question ids
-- remain stable while the wording/order matches the consumer-facing calibration flow.
update public.player_initialization_questions q
set
  question_key = case q.question_key
    when 'life_context' then 'life_context'
    when 'schedule_structure' then 'schedule_structure'
    when 'current_direction' then 'current_direction'
    when 'primary_activity' then 'desired_outcome'
    when 'major_constraint' then 'major_constraint'
    else q.question_key
  end,
  dimension = case q.question_key
    when 'life_context' then 'current_state'
    when 'schedule_structure' then 'capacity_constraints'
    when 'current_direction' then 'direction'
    when 'primary_activity' then 'direction'
    when 'major_constraint' then 'bottleneck_opportunity'
    else q.dimension
  end,
  prompt = case q.question_key
    when 'life_context' then 'Sekarang keseharian lo lagi kayak gimana?'
    when 'schedule_structure' then 'Biasanya seminggu lo kayak gimana? Kapan paling sibuk, dan kapan biasanya agak kosong?'
    when 'current_direction' then 'Beberapa minggu ke depan, apa yang paling pengen lo fokusin?'
    when 'primary_activity' then 'Kalau itu berjalan sesuai yang lo mau, hasil yang pengen lo lihat tuh kayak gimana?'
    when 'major_constraint' then 'Sekarang yang paling bikin susah buat sampai ke sana apa?'
    else q.prompt
  end,
  reason = case q.question_key
    when 'life_context' then 'Establish the player current daily reality and major time commitments without assuming which domain matters.'
    when 'schedule_structure' then 'Establish realistic recurring capacity by locating busy and open parts of the week.'
    when 'current_direction' then 'Establish one explicit near-term focus rather than inferring direction from identity or role.'
    when 'primary_activity' then 'Establish the observable near-term outcome the player wants to see if that focus moves.'
    when 'major_constraint' then 'Establish the main blocker or leverage point between the player and that desired outcome.'
    else q.reason
  end,
  priority = case q.question_key
    when 'life_context' then 5
    when 'schedule_structure' then 4
    when 'current_direction' then 5
    when 'primary_activity' then 5
    when 'major_constraint' then 5
    else q.priority
  end,
  sequence = case q.question_key
    when 'life_context' then 10
    when 'schedule_structure' then 20
    when 'current_direction' then 30
    when 'primary_activity' then 40
    when 'major_constraint' then 50
    else q.sequence
  end,
  updated_at = now()
from public.player_initializations pi
where pi.user_id = q.user_id
  and pi.readiness <> 'ready'
  and q.origin = 'basic'
  and q.status = 'pending'
  and q.calibration_version = 0
  and q.question_key in ('life_context','schedule_structure','current_direction','primary_activity','major_constraint');

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
      (v_user_id,'basic','life_context','current_state','Sekarang keseharian lo lagi kayak gimana?','Establish the player current daily reality and major time commitments without assuming which domain matters.',5,10,0),
      (v_user_id,'basic','schedule_structure','capacity_constraints','Biasanya seminggu lo kayak gimana? Kapan paling sibuk, dan kapan biasanya agak kosong?','Establish realistic recurring capacity by locating busy and open parts of the week.',4,20,0),
      (v_user_id,'basic','current_direction','direction','Beberapa minggu ke depan, apa yang paling pengen lo fokusin?','Establish one explicit near-term focus rather than inferring direction from identity or role.',5,30,0),
      (v_user_id,'basic','desired_outcome','direction','Kalau itu berjalan sesuai yang lo mau, hasil yang pengen lo lihat tuh kayak gimana?','Establish the observable near-term outcome the player wants to see if that focus moves.',5,40,0),
      (v_user_id,'basic','major_constraint','bottleneck_opportunity','Sekarang yang paling bikin susah buat sampai ke sana apa?','Establish the main blocker or leverage point between the player and that desired outcome.',5,50,0)
    on conflict(user_id,question_key) where origin='basic' do nothing;
  end if;

  select * into v_state from public.player_initializations where user_id=v_user_id;
  return v_state;
end;
$function$;

revoke all on function public.ensure_player_initialization() from public;
grant execute on function public.ensure_player_initialization() to authenticated;

commit;
