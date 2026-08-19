-- Progression intelligence layer: strategic map, response learning, progression target,
-- executable quest contracts, effectiveness evidence, and explicit no-intervention plans.

create table if not exists public.progression_maps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  version integer not null check (version > 0),
  schema_version text not null default 'progression-map.v1',
  map jsonb not null check (jsonb_typeof(map) = 'object'),
  is_current boolean not null default true,
  reason text not null,
  provider_id text,
  model_id text,
  model_request_id text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, version)
);

create unique index if not exists progression_maps_one_current_idx
  on public.progression_maps(user_id) where is_current;

create table if not exists public.player_response_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  version integer not null check (version > 0),
  schema_version text not null default 'player-response-model.v1',
  model jsonb not null check (jsonb_typeof(model) = 'object'),
  is_current boolean not null default true,
  reason text not null,
  provider_id text,
  model_id text,
  model_request_id text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, version)
);

create unique index if not exists player_response_models_one_current_idx
  on public.player_response_models(user_id) where is_current;

create table if not exists public.progression_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  target_date date not null,
  progression_map_id uuid not null,
  player_response_model_id uuid,
  daily_context_id uuid not null,
  schema_version text not null default 'progression-target.v1',
  decision jsonb not null check (jsonb_typeof(decision) = 'object'),
  provider_id text,
  model_id text,
  model_request_id text,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, target_date),
  constraint progression_targets_map_owner_fkey
    foreign key (progression_map_id, user_id)
    references public.progression_maps(id, user_id)
    on delete restrict,
  constraint progression_targets_response_owner_fkey
    foreign key (player_response_model_id, user_id)
    references public.player_response_models(id, user_id)
    on delete restrict,
  constraint progression_targets_context_owner_fkey
    foreign key (daily_context_id, user_id)
    references public.daily_contexts(id, user_id)
    on delete restrict
);

create table if not exists public.quest_response_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  quest_id uuid not null,
  quest_date date not null,
  outcome text not null check (outcome in ('completed','partial','skipped','failed')),
  note text,
  quest_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(quest_snapshot) = 'object'),
  strategic_chain jsonb not null default '{}'::jsonb check (jsonb_typeof(strategic_chain) = 'object'),
  execution_contract jsonb not null default '{}'::jsonb check (jsonb_typeof(execution_contract) = 'object'),
  daily_context jsonb not null default '{}'::jsonb check (jsonb_typeof(daily_context) = 'object'),
  inferred_barrier text,
  effectiveness text not null default 'unknown' check (effectiveness in ('unknown','none','weak','moderate','strong')),
  effectiveness_reason text not null default 'Downstream progression has not been established yet.',
  evidence_signal_ids uuid[] not null default '{}'::uuid[],
  review_confidence numeric not null default 0 check (review_confidence >= 0 and review_confidence <= 1),
  review_version text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quest_id),
  unique (id, user_id),
  constraint quest_response_events_quest_owner_fkey
    foreign key (quest_id, user_id)
    references public.daily_quests(id, user_id)
    on delete cascade
);

alter table public.daily_quests
  add column if not exists progression_target_id uuid,
  add column if not exists candidate_id text,
  add column if not exists strategic_chain jsonb not null default '{}'::jsonb,
  add column if not exists execution_contract jsonb not null default '{}'::jsonb;

alter table public.quest_batches
  add column if not exists progression_target_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_quests_strategic_chain_object'
      and conrelid = 'public.daily_quests'::regclass
  ) then
    alter table public.daily_quests
      add constraint daily_quests_strategic_chain_object check (jsonb_typeof(strategic_chain) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_quests_execution_contract_object'
      and conrelid = 'public.daily_quests'::regclass
  ) then
    alter table public.daily_quests
      add constraint daily_quests_execution_contract_object check (jsonb_typeof(execution_contract) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_quests_progression_target_owner_fkey'
      and conrelid = 'public.daily_quests'::regclass
  ) then
    alter table public.daily_quests
      add constraint daily_quests_progression_target_owner_fkey
      foreign key (progression_target_id, user_id)
      references public.progression_targets(id, user_id)
      on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'quest_batches_progression_target_owner_fkey'
      and conrelid = 'public.quest_batches'::regclass
  ) then
    alter table public.quest_batches
      add constraint quest_batches_progression_target_owner_fkey
      foreign key (progression_target_id, user_id)
      references public.progression_targets(id, user_id)
      on delete restrict;
  end if;
end
$$;

create index if not exists quest_response_events_user_date_idx
  on public.quest_response_events(user_id, quest_date desc, updated_at desc);
create index if not exists daily_quests_progression_target_idx
  on public.daily_quests(user_id, progression_target_id);

alter table public.progression_maps enable row level security;
alter table public.player_response_models enable row level security;
alter table public.progression_targets enable row level security;
alter table public.quest_response_events enable row level security;

revoke all on table public.progression_maps, public.player_response_models, public.progression_targets, public.quest_response_events
  from anon, authenticated;
grant select on table public.progression_maps, public.player_response_models, public.progression_targets, public.quest_response_events
  to authenticated;
grant select, insert, update, delete on table public.progression_maps, public.player_response_models, public.progression_targets, public.quest_response_events
  to service_role;

drop policy if exists progression_maps_select_own on public.progression_maps;
create policy progression_maps_select_own on public.progression_maps
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists player_response_models_select_own on public.player_response_models;
create policy player_response_models_select_own on public.player_response_models
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists progression_targets_select_own on public.progression_targets;
create policy progression_targets_select_own on public.progression_targets
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists quest_response_events_select_own on public.quest_response_events;
create policy quest_response_events_select_own on public.quest_response_events
for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.persist_progression_map(
  p_user_id uuid,
  p_map jsonb,
  p_signal_ids uuid[],
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'progression-map.v1',
  p_reason text default 'strategic_state_refresh',
  p_generated_at timestamptz default now()
)
returns public.progression_maps
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version integer;
  v_expected integer;
  v_actual integer;
  v_row public.progression_maps;
begin
  if p_map is null or jsonb_typeof(p_map) <> 'object' then raise exception 'Progression Map must be an object'; end if;
  if p_signal_ids is null then p_signal_ids := '{}'::uuid[]; end if;
  select count(*) into v_expected from (select distinct unnest(p_signal_ids)) ids;
  select count(*) into v_actual from public.player_signals where user_id=p_user_id and id=any(p_signal_ids);
  if v_actual <> v_expected then raise exception 'Progression Map references missing or cross-player signals'; end if;

  perform pg_advisory_xact_lock(hashtextextended('progression-map:' || p_user_id::text, 0));
  select coalesce(max(version),0)+1 into v_version from public.progression_maps where user_id=p_user_id;
  update public.progression_maps set is_current=false where user_id=p_user_id and is_current;
  insert into public.progression_maps(user_id,version,schema_version,map,is_current,reason,provider_id,model_id,model_request_id,generated_at)
  values(p_user_id,v_version,p_version,p_map,true,p_reason,p_provider_id,p_model_id,p_request_id,p_generated_at)
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.persist_progression_map(uuid,jsonb,uuid[],text,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.persist_progression_map(uuid,jsonb,uuid[],text,text,text,text,text,timestamptz) to service_role;

create or replace function public.sync_quest_response_events(
  p_user_id uuid,
  p_through_date date
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_synced integer := 0;
begin
  insert into public.quest_response_events(
    user_id,quest_id,quest_date,outcome,note,quest_snapshot,strategic_chain,execution_contract,daily_context,updated_at
  )
  select
    q.user_id,
    q.id,
    q.quest_date,
    coalesce(r.outcome, case when q.status='pending' and q.quest_date < p_through_date then 'skipped' else q.status end),
    r.note,
    jsonb_build_object(
      'title',q.title,'kind',q.kind,'difficulty',q.difficulty,'priority',q.priority,'xp',q.xp,'status',q.status,
      'candidateId',q.candidate_id,'progressionTargetId',q.progression_target_id
    ),
    coalesce(q.strategic_chain,'{}'::jsonb),
    coalesce(q.execution_contract,'{}'::jsonb),
    coalesce((
      select jsonb_build_object('mode',d.mode,'text',d.context_text)
      from public.daily_contexts d
      where d.user_id=q.user_id and d.context_date=q.quest_date
    ), '{}'::jsonb),
    now()
  from public.daily_quests q
  left join public.quest_results r on r.quest_id=q.id and r.user_id=q.user_id
  where q.user_id=p_user_id
    and q.quest_date <= p_through_date
    and (
      r.id is not null
      or q.status in ('partial','skipped','failed')
      or (q.status='pending' and q.quest_date < p_through_date)
    )
  on conflict (quest_id) do update
  set outcome=excluded.outcome,
      note=excluded.note,
      quest_snapshot=excluded.quest_snapshot,
      strategic_chain=excluded.strategic_chain,
      execution_contract=excluded.execution_contract,
      daily_context=excluded.daily_context,
      updated_at=now();

  get diagnostics v_synced = row_count;
  return jsonb_build_object('synced',v_synced);
end;
$$;

revoke execute on function public.sync_quest_response_events(uuid,date) from public,anon,authenticated;
grant execute on function public.sync_quest_response_events(uuid,date) to service_role;

create or replace function public.persist_quest_response_reviews(
  p_user_id uuid,
  p_reviews jsonb,
  p_version text default 'quest-response.v1'
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_review jsonb;
  v_quest_id uuid;
  v_signal_ids uuid[];
  v_count integer := 0;
  v_expected integer;
  v_actual integer;
begin
  if p_reviews is null or jsonb_typeof(p_reviews) <> 'array' then raise exception 'Quest response reviews must be an array'; end if;
  for v_review in select value from jsonb_array_elements(p_reviews)
  loop
    v_quest_id := (v_review->>'questId')::uuid;
    if not exists(select 1 from public.quest_response_events where user_id=p_user_id and quest_id=v_quest_id) then
      raise exception 'Quest response review references missing or cross-player event';
    end if;
    select coalesce(array_agg(value::uuid),'{}'::uuid[]) into v_signal_ids
      from jsonb_array_elements_text(coalesce(v_review->'evidenceSignalIds','[]'::jsonb));
    select count(*) into v_expected from (select distinct unnest(v_signal_ids)) ids;
    select count(*) into v_actual from public.player_signals where user_id=p_user_id and id=any(v_signal_ids);
    if v_actual <> v_expected then raise exception 'Quest response review references signals outside player context'; end if;

    update public.quest_response_events
    set inferred_barrier=nullif(btrim(v_review->>'inferredBarrier'),''),
        effectiveness=v_review->>'effectiveness',
        effectiveness_reason=btrim(v_review->>'effectivenessReason'),
        evidence_signal_ids=v_signal_ids,
        review_confidence=(v_review->>'confidence')::numeric,
        review_version=p_version,
        reviewed_at=now(),
        updated_at=now()
    where user_id=p_user_id and quest_id=v_quest_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.persist_quest_response_reviews(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.persist_quest_response_reviews(uuid,jsonb,text) to service_role;

create or replace function public.persist_player_response_model(
  p_user_id uuid,
  p_model jsonb,
  p_quest_ids uuid[],
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'player-response-model.v1',
  p_reason text default 'behavioral_state_refresh',
  p_generated_at timestamptz default now()
)
returns public.player_response_models
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version integer;
  v_expected integer;
  v_actual integer;
  v_row public.player_response_models;
begin
  if p_model is null or jsonb_typeof(p_model) <> 'object' then raise exception 'Player Response Model must be an object'; end if;
  p_quest_ids := coalesce(p_quest_ids,'{}'::uuid[]);
  select count(*) into v_expected from (select distinct unnest(p_quest_ids)) ids;
  select count(*) into v_actual from public.daily_quests where user_id=p_user_id and id=any(p_quest_ids);
  if v_actual <> v_expected then raise exception 'Player Response Model references missing or cross-player quests'; end if;

  perform pg_advisory_xact_lock(hashtextextended('player-response-model:' || p_user_id::text, 0));
  select coalesce(max(version),0)+1 into v_version from public.player_response_models where user_id=p_user_id;
  update public.player_response_models set is_current=false where user_id=p_user_id and is_current;
  insert into public.player_response_models(user_id,version,schema_version,model,is_current,reason,provider_id,model_id,model_request_id,generated_at)
  values(p_user_id,v_version,p_version,p_model,true,p_reason,p_provider_id,p_model_id,p_request_id,p_generated_at)
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.persist_player_response_model(uuid,jsonb,uuid[],text,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.persist_player_response_model(uuid,jsonb,uuid[],text,text,text,text,text,timestamptz) to service_role;

create or replace function public.persist_progression_target(
  p_user_id uuid,
  p_target_date date,
  p_progression_map_id uuid,
  p_player_response_model_id uuid,
  p_daily_context_id uuid,
  p_decision jsonb,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'progression-target.v1'
)
returns public.progression_targets
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.progression_targets;
begin
  if p_decision is null or jsonb_typeof(p_decision) <> 'object' then raise exception 'Progression Target decision must be an object'; end if;
  if not exists(select 1 from public.progression_maps where id=p_progression_map_id and user_id=p_user_id) then raise exception 'Progression Target map mismatch'; end if;
  if p_player_response_model_id is not null and not exists(select 1 from public.player_response_models where id=p_player_response_model_id and user_id=p_user_id) then raise exception 'Progression Target response model mismatch'; end if;
  if not exists(select 1 from public.daily_contexts where id=p_daily_context_id and user_id=p_user_id and context_date=p_target_date) then raise exception 'Progression Target Daily Context mismatch'; end if;

  insert into public.progression_targets(user_id,target_date,progression_map_id,player_response_model_id,daily_context_id,schema_version,decision,provider_id,model_id,model_request_id)
  values(p_user_id,p_target_date,p_progression_map_id,p_player_response_model_id,p_daily_context_id,p_version,p_decision,p_provider_id,p_model_id,p_request_id)
  on conflict(user_id,target_date) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.progression_targets where user_id=p_user_id and target_date=p_target_date;
  end if;
  return v_row;
end;
$$;

revoke execute on function public.persist_progression_target(uuid,date,uuid,uuid,uuid,jsonb,text,text,text,text) from public,anon,authenticated;
grant execute on function public.persist_progression_target(uuid,date,uuid,uuid,uuid,jsonb,text,text,text,text) to service_role;

create or replace function public.attach_quest_intelligence_metadata(
  p_user_id uuid,
  p_quest_date date,
  p_progression_target_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_quest_id uuid;
begin
  if not exists(select 1 from public.progression_targets where id=p_progression_target_id and user_id=p_user_id and target_date=p_quest_date) then
    raise exception 'Quest metadata Progression Target mismatch';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Quest metadata items must be an array'; end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_quest_id := (v_item->>'questId')::uuid;
    if not exists(select 1 from public.daily_quests where id=v_quest_id and user_id=p_user_id and quest_date=p_quest_date) then
      raise exception 'Quest metadata references missing or cross-player quest';
    end if;
    update public.daily_quests
    set progression_target_id=p_progression_target_id,
        candidate_id=nullif(btrim(v_item->>'candidateId'),''),
        strategic_chain=coalesce(v_item->'strategicChain','{}'::jsonb),
        execution_contract=coalesce(v_item->'executionContract','{}'::jsonb)
    where id=v_quest_id and user_id=p_user_id;
  end loop;

  update public.quest_batches
  set progression_target_id=p_progression_target_id
  where user_id=p_user_id and quest_date=p_quest_date;
end;
$$;

revoke execute on function public.attach_quest_intelligence_metadata(uuid,date,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.attach_quest_intelligence_metadata(uuid,date,uuid,jsonb) to service_role;

create or replace function public.persist_no_quest_plan(
  p_user_id uuid,
  p_quest_date date,
  p_progression_target_id uuid,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'daily-quest.v3',
  p_retrieval jsonb default '{}'::jsonb
)
returns public.quest_batches
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_target public.progression_targets;
  v_snapshot_id uuid;
  v_batch public.quest_batches;
begin
  select * into v_target from public.progression_targets where id=p_progression_target_id and user_id=p_user_id and target_date=p_quest_date;
  if v_target.id is null then raise exception 'No-quest plan Progression Target mismatch'; end if;
  if v_target.decision->>'mode' <> 'no_intervention' then raise exception 'No-quest plan requires no_intervention target'; end if;
  if exists(select 1 from public.daily_quests where user_id=p_user_id and quest_date=p_quest_date) then raise exception 'Cannot persist no-quest plan after quests exist'; end if;

  select * into v_batch from public.quest_batches where user_id=p_user_id and quest_date=p_quest_date;
  if v_batch.id is not null then return v_batch; end if;

  insert into public.context_snapshots(user_id,context_date,purpose,summary,retrieval_metadata,generated_at,player_brief_id)
  values(
    p_user_id,p_quest_date,'daily_quest','System intentionally provided no Daily Quest',
    p_retrieval || jsonb_build_object('noQuest',true,'noQuestReason',v_target.decision->>'noQuestReason','progressionTargetId',v_target.id,'schema_version',p_version),
    now(),
    nullif(p_retrieval->>'playerBriefId','')::uuid
  ) returning id into v_snapshot_id;

  insert into public.quest_batches(user_id,quest_date,context_snapshot_id,status,provider_id,model_id,model_request_id,generation_version,generation_metadata,completed_at,progression_target_id)
  values(
    p_user_id,p_quest_date,v_snapshot_id,'generated',p_provider_id,p_model_id,p_request_id,p_version,
    p_retrieval || jsonb_build_object('noQuest',true,'noQuestReason',v_target.decision->>'noQuestReason','progressionTargetId',v_target.id),
    now(),p_progression_target_id
  ) returning * into v_batch;
  return v_batch;
end;
$$;

revoke execute on function public.persist_no_quest_plan(uuid,date,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.persist_no_quest_plan(uuid,date,uuid,text,text,text,text,jsonb) to service_role;

-- Existing plan detection now includes an explicit zero-quest generated batch.
create or replace function public.request_progression_cycle(p_target_date date)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $$
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
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_target_date is null then raise exception 'target date is required'; end if;
  if not exists(select 1 from public.users where id=v_user_id) then raise exception 'Authenticated account is not linked to a player' using errcode='42501'; end if;

  select exists(select 1 from public.quest_batches where user_id=v_user_id and quest_date=p_target_date and status='generated')
    into v_has_plan;
  select exists(select 1 from public.daily_contexts where user_id=v_user_id and context_date=p_target_date)
    into v_has_daily_context;
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
$$;

revoke execute on function public.request_progression_cycle(date) from public,anon;
grant execute on function public.request_progression_cycle(date) to authenticated;

-- Completion records compliance and always queues a learning pass. It never rerolls today's plan.
create or replace function public.set_daily_quest_completion(p_quest_id uuid, p_completed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_quest_date date;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select status,quest_date into v_status,v_quest_date from public.daily_quests where id=p_quest_id and user_id=v_user_id for update;
  if v_status is null then raise exception 'Quest not found for authenticated player' using errcode='42501'; end if;
  if v_status in ('deferred','cancelled','replaced','skipped','failed') then raise exception 'Historical or interrupted quest cannot be toggled'; end if;

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

  insert into public.ai_inference_jobs(user_id,operation,target_date,status,completed_at,activity_window_started_at,window_cutoff_at)
  values(v_user_id,'progression_cycle',v_quest_date,'queued',null,now(),null)
  on conflict(user_id,operation,target_date) do update
  set status=case when public.ai_inference_jobs.status='running' then 'running' else 'queued' end,
      rerun_requested=case when public.ai_inference_jobs.status='running' then true else false end,
      correlation_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.correlation_id else gen_random_uuid() end,
      attempt_count=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.attempt_count else 0 end,
      available_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.available_at else now() end,
      completed_at=null,error_code=null,error_message=null,
      activity_window_started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.activity_window_started_at else now() end,
      updated_at=now();
end;
$$;

revoke execute on function public.set_daily_quest_completion(uuid,boolean) from public,anon;
grant execute on function public.set_daily_quest_completion(uuid,boolean) to authenticated;
