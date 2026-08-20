begin;

create table if not exists public.player_initializations (
  user_id uuid primary key references public.users(id) on delete cascade,
  stage text not null default 'initializing' check (stage in ('initializing','calibrating','ready')),
  readiness text not null default 'ask' check (readiness in ('ask','ready')),
  readiness_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(readiness_dimensions)='object'),
  readiness_reason text,
  calibration_version integer not null default 0 check (calibration_version >= 0),
  schema_version text not null default 'player-initialization.v1',
  last_provider_id text,
  last_model_id text,
  last_request_id text,
  last_calibrated_at timestamptz,
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.player_initialization_questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  origin text not null check (origin in ('basic','adaptive')),
  question_key text not null check (char_length(btrim(question_key)) between 1 and 120),
  dimension text not null check (dimension in ('direction','current_state','bottleneck_opportunity','capacity_constraints')),
  prompt text not null check (char_length(btrim(prompt)) between 1 and 1000),
  reason text,
  priority smallint not null default 3 check (priority between 1 and 5),
  sequence smallint not null default 0 check (sequence between 0 and 100),
  calibration_version integer not null default 0 check (calibration_version >= 0),
  status text not null default 'pending' check (status in ('pending','answered','skipped','superseded')),
  answer_text text check (answer_text is null or char_length(answer_text) between 1 and 5000),
  answer_knowledge_entry_id uuid references public.knowledge_entries(id) on delete set null,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists player_initialization_basic_question_key_unique
  on public.player_initialization_questions(user_id,question_key)
  where origin='basic';

create unique index if not exists player_initialization_calibration_question_key_unique
  on public.player_initialization_questions(user_id,calibration_version,question_key)
  where origin='adaptive';

create index if not exists player_initialization_next_question_idx
  on public.player_initialization_questions(user_id,status,origin,priority desc,sequence,created_at);

alter table public.player_initializations enable row level security;
alter table public.player_initialization_questions enable row level security;

drop policy if exists player_initializations_select_own on public.player_initializations;
create policy player_initializations_select_own on public.player_initializations
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists player_initialization_questions_select_own on public.player_initialization_questions;
create policy player_initialization_questions_select_own on public.player_initialization_questions
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.player_initializations from anon, authenticated;
revoke all on public.player_initialization_questions from anon, authenticated;
grant select on public.player_initializations to authenticated;
grant select on public.player_initialization_questions to authenticated;

insert into public.player_initializations(
  user_id,stage,readiness,readiness_dimensions,readiness_reason,calibration_version,ready_at
)
select
  u.id,
  case when progressed.has_progression then 'ready' else 'initializing' end,
  case when progressed.has_progression then 'ready' else 'ask' end,
  case when progressed.has_progression then jsonb_build_object(
    'direction',jsonb_build_object('status','sufficient','confidence',1,'summary','Existing player progression predates initialization rollout.'),
    'current_state',jsonb_build_object('status','sufficient','confidence',1,'summary','Existing player progression predates initialization rollout.'),
    'bottleneck_opportunity',jsonb_build_object('status','sufficient','confidence',1,'summary','Existing player progression predates initialization rollout.'),
    'capacity_constraints',jsonb_build_object('status','sufficient','confidence',1,'summary','Existing player progression predates initialization rollout.')
  ) else '{}'::jsonb end,
  case when progressed.has_progression then 'Existing progressed player preserved as READY during initialization rollout.' else null end,
  0,
  case when progressed.has_progression then now() else null end
from public.users u
cross join lateral (
  select
    exists(select 1 from public.daily_quests q where q.user_id=u.id)
    or exists(select 1 from public.derived_understanding d where d.user_id=u.id) as has_progression
) progressed
on conflict(user_id) do nothing;

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

create or replace function public.submit_player_initialization_answer(
  p_question_id uuid,
  p_answer text default null,
  p_skip boolean default false
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_question public.player_initialization_questions;
  v_answer text := btrim(coalesce(p_answer,''));
  v_source_id uuid;
  v_entry_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_question_id is null then raise exception 'question id is required'; end if;

  select * into v_question
  from public.player_initialization_questions
  where id=p_question_id and user_id=v_user_id
  for update;
  if not found then raise exception 'Initialization question not found' using errcode='42501'; end if;
  if v_question.status <> 'pending' then raise exception 'Initialization question is no longer pending'; end if;

  if p_skip then
    update public.player_initialization_questions
    set status='skipped',answer_text=null,answer_knowledge_entry_id=null,answered_at=now(),updated_at=now()
    where id=v_question.id;

    update public.player_initializations
    set stage=case when v_question.origin='adaptive' then 'calibrating' else 'initializing' end,
        readiness='ask',updated_at=now()
    where user_id=v_user_id and readiness<>'ready';
    return null;
  end if;

  if char_length(v_answer) < 1 or char_length(v_answer) > 5000 then
    raise exception 'Initialization answer must be between 1 and 5000 characters';
  end if;

  insert into public.knowledge_sources(user_id,source_type,title,metadata,occurred_at)
  values(
    v_user_id,'note','Player initialization',
    jsonb_build_object(
      'system','player_initialization',
      'questionId',v_question.id,
      'questionKey',v_question.question_key,
      'dimension',v_question.dimension,
      'origin',v_question.origin,
      'calibrationVersion',v_question.calibration_version
    ),
    now()
  ) returning id into v_source_id;

  insert into public.knowledge_entries(user_id,source_id,entry_type,raw_text,content_metadata,occurred_at)
  values(
    v_user_id,v_source_id,'note',
    format('Initialization question: %s\nPlayer answer: %s',v_question.prompt,v_answer),
    jsonb_build_object(
      'system','player_initialization',
      'questionId',v_question.id,
      'questionKey',v_question.question_key,
      'dimension',v_question.dimension,
      'origin',v_question.origin,
      'calibrationVersion',v_question.calibration_version
    ),
    now()
  ) returning id into v_entry_id;

  update public.player_initialization_questions
  set status='answered',answer_text=v_answer,answer_knowledge_entry_id=v_entry_id,answered_at=now(),updated_at=now()
  where id=v_question.id;

  if v_question.origin='adaptive' then
    update public.player_initialization_questions
    set status='superseded',updated_at=now()
    where user_id=v_user_id
      and origin='adaptive'
      and status='pending'
      and dimension=v_question.dimension
      and id<>v_question.id;
  end if;

  update public.player_initializations
  set stage=case when v_question.origin='adaptive' then 'calibrating' else 'initializing' end,
      readiness='ask',updated_at=now()
  where user_id=v_user_id and readiness<>'ready';

  return v_entry_id;
end;
$function$;

revoke all on function public.submit_player_initialization_answer(uuid,text,boolean) from public;
grant execute on function public.submit_player_initialization_answer(uuid,text,boolean) to authenticated;

create or replace function public.reset_skipped_initialization_questions()
returns integer
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_count integer := 0;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if exists(select 1 from public.player_initializations where user_id=v_user_id and readiness='ready') then return 0; end if;

  update public.player_initialization_questions q
  set status='pending',answered_at=null,updated_at=now()
  where q.user_id=v_user_id
    and q.status='skipped'
    and (
      q.origin='basic'
      or q.calibration_version=(select max(x.calibration_version) from public.player_initialization_questions x where x.user_id=v_user_id and x.origin='adaptive')
    );
  get diagnostics v_count=row_count;
  return v_count;
end;
$function$;

revoke all on function public.reset_skipped_initialization_questions() from public;
grant execute on function public.reset_skipped_initialization_questions() to authenticated;

create or replace function public.request_initialization_calibration()
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_timezone text;
  v_target_date date;
  v_state public.player_initializations;
  v_job public.ai_inference_jobs;
  v_has_pending_answer boolean := false;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not exists(select 1 from public.users where id=v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode='42501';
  end if;

  perform public.ensure_player_initialization();
  select * into v_state from public.player_initializations where user_id=v_user_id for update;
  if v_state.readiness='ready' then raise exception 'Player Initialization is already READY'; end if;

  if exists(select 1 from public.player_initialization_questions where user_id=v_user_id and status='pending') then
    raise exception 'Answer or skip the current initialization questions before calibration';
  end if;

  select exists(
    select 1
    from public.player_initialization_questions q
    join public.knowledge_entries k on k.id=q.answer_knowledge_entry_id and k.user_id=q.user_id
    where q.user_id=v_user_id
      and q.status='answered'
      and k.processing_status in ('pending','failed')
  ) into v_has_pending_answer;
  if not v_has_pending_answer then
    raise exception 'Answer at least one initialization question with new evidence before calibration';
  end if;

  select timezone into v_timezone from public.users where id=v_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone := 'UTC'; end if;
  v_target_date := (now() at time zone v_timezone)::date;

  update public.player_initializations set stage='calibrating',updated_at=now() where user_id=v_user_id;

  insert into public.ai_inference_jobs(
    user_id,operation,target_date,status,available_at,result_summary,activity_window_started_at,window_cutoff_at
  ) values (
    v_user_id,'progression_cycle',v_target_date,'queued',now(),
    jsonb_build_object('decisionPoint','initialization_calibration'),now(),null
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
      result_summary=coalesce(public.ai_inference_jobs.result_summary,'{}'::jsonb)||jsonb_build_object('decisionPoint','initialization_calibration'),
      error_code=null,error_message=null,
      started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.started_at else null end,
      completed_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.completed_at else null end,
      activity_window_started_at=case when public.ai_inference_jobs.status='running' then coalesce(public.ai_inference_jobs.activity_window_started_at,now()) else now() end,
      window_cutoff_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.window_cutoff_at else null end,
      updated_at=now()
  returning * into v_job;

  return v_job;
end;
$function$;

revoke all on function public.request_initialization_calibration() from public;
grant execute on function public.request_initialization_calibration() to authenticated;

create or replace function public.persist_player_initialization_calibration_internal(
  p_user_id uuid,
  p_readiness text,
  p_reason text,
  p_dimensions jsonb,
  p_questions jsonb,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_schema_version text default 'player-initialization-calibration.v1'
)
returns public.player_initializations
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_state public.player_initializations;
  v_next_version integer;
  v_question jsonb;
  v_dimension text;
  v_key text;
  v_prompt text;
  v_reason text;
  v_priority integer;
  v_sequence integer;
begin
  if p_user_id is null then raise exception 'player id is required'; end if;
  if p_readiness not in ('ask','ready') then raise exception 'Initialization readiness must be ASK or READY'; end if;
  if p_dimensions is null or jsonb_typeof(p_dimensions)<>'object' then raise exception 'Initialization dimensions must be an object'; end if;
  if p_questions is null or jsonb_typeof(p_questions)<>'array' then raise exception 'Initialization questions must be an array'; end if;
  if char_length(btrim(coalesce(p_reason,''))) < 1 then raise exception 'Initialization readiness reason is required'; end if;
  if jsonb_array_length(p_questions) > 5 then raise exception 'Initialization calibration may propose at most five questions'; end if;

  if p_readiness='ready' then
    if jsonb_array_length(p_questions)<>0 then raise exception 'READY initialization cannot include follow-up questions'; end if;
    if coalesce(p_dimensions->'direction'->>'status','')<>'sufficient'
      or coalesce(p_dimensions->'current_state'->>'status','')<>'sufficient'
      or coalesce(p_dimensions->'bottleneck_opportunity'->>'status','')<>'sufficient'
      or coalesce(p_dimensions->'capacity_constraints'->>'status','')<>'sufficient' then
      raise exception 'READY initialization requires all four readiness dimensions to be sufficient';
    end if;
  elsif jsonb_array_length(p_questions)=0 then
    raise exception 'ASK initialization requires at least one follow-up question';
  end if;

  select * into v_state from public.player_initializations where user_id=p_user_id for update;
  if not found then raise exception 'Player Initialization state not found'; end if;
  if v_state.readiness='ready' then return v_state; end if;

  v_next_version := v_state.calibration_version + 1;

  update public.player_initialization_questions
  set status='superseded',updated_at=now()
  where user_id=p_user_id and origin='adaptive' and status='pending';

  if p_readiness='ask' then
    for v_question in select value from jsonb_array_elements(p_questions)
    loop
      v_key := btrim(coalesce(v_question->>'questionKey',''));
      v_dimension := btrim(coalesce(v_question->>'dimension',''));
      v_prompt := btrim(coalesce(v_question->>'prompt',''));
      v_reason := btrim(coalesce(v_question->>'reason',''));
      v_priority := coalesce((v_question->>'priority')::integer,3);
      v_sequence := coalesce((v_question->>'sequence')::integer,0);

      if char_length(v_key)<1 or char_length(v_key)>120 then raise exception 'Invalid adaptive question key'; end if;
      if v_dimension not in ('direction','current_state','bottleneck_opportunity','capacity_constraints') then raise exception 'Invalid adaptive question dimension'; end if;
      if char_length(v_prompt)<1 or char_length(v_prompt)>1000 then raise exception 'Invalid adaptive question prompt'; end if;
      if char_length(v_reason)<1 or char_length(v_reason)>1000 then raise exception 'Invalid adaptive question reason'; end if;
      if v_priority<1 or v_priority>5 then raise exception 'Invalid adaptive question priority'; end if;
      if v_sequence<0 or v_sequence>100 then raise exception 'Invalid adaptive question sequence'; end if;

      insert into public.player_initialization_questions(
        user_id,origin,question_key,dimension,prompt,reason,priority,sequence,calibration_version,status
      ) values(
        p_user_id,'adaptive',v_key,v_dimension,v_prompt,v_reason,v_priority,v_sequence,v_next_version,'pending'
      );
    end loop;
  end if;

  update public.player_initializations
  set stage=case when p_readiness='ready' then 'ready' else 'calibrating' end,
      readiness=p_readiness,
      readiness_dimensions=p_dimensions,
      readiness_reason=btrim(p_reason),
      calibration_version=v_next_version,
      schema_version=coalesce(nullif(btrim(p_schema_version),''),'player-initialization-calibration.v1'),
      last_provider_id=nullif(btrim(coalesce(p_provider_id,'')),''),
      last_model_id=nullif(btrim(coalesce(p_model_id,'')),''),
      last_request_id=nullif(btrim(coalesce(p_request_id,'')),''),
      last_calibrated_at=now(),
      ready_at=case when p_readiness='ready' then now() else ready_at end,
      updated_at=now()
  where user_id=p_user_id
  returning * into v_state;

  return v_state;
end;
$function$;

revoke all on function public.persist_player_initialization_calibration_internal(uuid,text,text,jsonb,jsonb,text,text,text,text) from public, anon, authenticated;
grant execute on function public.persist_player_initialization_calibration_internal(uuid,text,text,jsonb,jsonb,text,text,text,text) to service_role;

-- WAIT policy: raw Life Vault evidence is saved immediately but does not enqueue AI by itself.
drop trigger if exists knowledge_entries_enqueue_progression on public.knowledge_entries;
create or replace function public.enqueue_progression_on_knowledge_insert()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  return new;
end;
$function$;

-- Inactivity/date rollover is not a decision point. Keep the cron target harmless for compatibility.
create or replace function public.enqueue_daily_progression_cycles()
returns integer
language plpgsql
security definer
set search_path=''
as $function$
begin
  return 0;
end;
$function$;

-- Explicit Daily Quest decisions are blocked until Player Initialization reaches READY.
create or replace function public.request_progression_cycle(p_target_date date)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_job public.ai_inference_jobs;
  v_has_plan boolean;
  v_has_daily_context boolean;
  v_has_pending_raw boolean;
  v_has_pending_materiality boolean;
  v_has_unresolved_interrupt boolean;
  v_has_pending_learning boolean;
  v_has_pending_progression boolean;
  v_readiness text;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_target_date is null then raise exception 'target date is required'; end if;
  if not exists(select 1 from public.users where id=v_user_id) then raise exception 'Authenticated account is not linked to a player' using errcode='42501'; end if;

  select readiness into v_readiness from public.player_initializations where user_id=v_user_id;
  if coalesce(v_readiness,'ask') <> 'ready' then
    raise exception 'Player Initialization is not READY; Daily Quest decision is blocked';
  end if;

  select exists(select 1 from public.quest_batches where user_id=v_user_id and quest_date=p_target_date and status='generated') into v_has_plan;
  select exists(select 1 from public.daily_contexts where user_id=v_user_id and context_date=p_target_date) into v_has_daily_context;
  if not v_has_plan and not v_has_daily_context then raise exception 'Daily Context check-in required before first Daily Quest generation'; end if;

  select exists(select 1 from public.knowledge_entries where user_id=v_user_id and processing_status in ('pending','failed')) into v_has_pending_raw;
  select exists(select 1 from public.knowledge_entries where user_id=v_user_id and processing_status='processed' and materiality_status in ('pending','failed')) into v_has_pending_materiality;
  select exists(
    select 1 from public.materiality_assessments a
    where a.user_id=v_user_id and a.target_date=p_target_date and a.disposition in ('suggest','auto_interrupt')
      and not exists(select 1 from public.quest_interrupts i where i.assessment_id=a.id)
  ) into v_has_unresolved_interrupt;
  select exists(
    select 1
    from public.daily_quests q
    left join public.quest_results r on r.quest_id=q.id and r.user_id=q.user_id
    left join public.quest_response_events e on e.quest_id=q.id and e.user_id=q.user_id
    where q.user_id=v_user_id
      and (
        (r.id is not null and (e.id is null or e.outcome<>r.outcome or e.reviewed_at is null))
        or (q.quest_date < p_target_date and q.status='pending' and (e.id is null or e.reviewed_at is null))
      )
  ) into v_has_pending_learning;

  v_has_pending_progression := v_has_pending_raw or v_has_pending_materiality or v_has_unresolved_interrupt or v_has_pending_learning;

  insert into public.ai_inference_jobs(user_id,operation,target_date,status,completed_at,activity_window_started_at,window_cutoff_at)
  values(
    v_user_id,'progression_cycle',p_target_date,
    case when v_has_plan and not v_has_pending_progression then 'succeeded' else 'queued' end,
    case when v_has_plan and not v_has_pending_progression then now() else null end,
    case when v_has_pending_progression then now() else null end,
    null
  )
  on conflict(user_id,operation,target_date) do update
  set status=case when public.ai_inference_jobs.status='running' then 'running' when v_has_plan and not v_has_pending_progression then 'succeeded' else 'queued' end,
      rerun_requested=case when public.ai_inference_jobs.status='running' and (v_has_pending_progression or (not v_has_plan and v_has_daily_context)) then true else false end,
      correlation_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.correlation_id else gen_random_uuid() end,
      attempt_count=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.attempt_count else 0 end,
      available_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.available_at else now() end,
      lease_expires_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.lease_expires_at else null end,
      worker_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.worker_id else null end,
      provider_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_id else null end,
      provider_conversation_refs=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_conversation_refs else '[]'::jsonb end,
      result_summary=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.result_summary else '{}'::jsonb end,
      error_code=null,error_message=null,
      started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.started_at else null end,
      completed_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.completed_at when v_has_plan and not v_has_pending_progression then now() else null end,
      activity_window_started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.activity_window_started_at when v_has_pending_progression then now() else null end,
      window_cutoff_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.window_cutoff_at else null end,
      updated_at=now()
  returning * into v_job;
  return v_job;
end;
$function$;

revoke all on function public.request_progression_cycle(date) from public;
grant execute on function public.request_progression_cycle(date) to authenticated;

commit;
