-- First-class, versioned player memory + understanding delta persistence.
-- Backward-compatible with existing understanding/signals/quests.

alter table public.derived_understanding
  add column if not exists importance smallint;

update public.derived_understanding u
set importance = coalesce((
  select max(s.importance)
  from public.player_signals s
  where s.user_id = u.user_id
    and s.source_understanding_id = u.id
), 3)
where u.importance is null;

alter table public.derived_understanding
  alter column importance set default 3,
  alter column importance set not null;

alter table public.derived_understanding
  drop constraint if exists derived_understanding_importance_check;
alter table public.derived_understanding
  add constraint derived_understanding_importance_check
  check (importance between 1 and 5);

create table if not exists public.player_briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  version integer not null,
  schema_version text not null default 'player-brief.v1',
  brief jsonb not null,
  is_current boolean not null default true,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint player_briefs_version_positive check (version > 0),
  constraint player_briefs_brief_object check (jsonb_typeof(brief) = 'object'),
  constraint player_briefs_id_user_id_key unique (id, user_id),
  constraint player_briefs_user_version_key unique (user_id, version)
);

create unique index if not exists player_briefs_one_current_per_user
  on public.player_briefs(user_id)
  where is_current;

create index if not exists player_briefs_user_version_desc
  on public.player_briefs(user_id, version desc);

create table if not exists public.player_brief_understanding_sources (
  user_id uuid not null references public.users(id) on delete cascade,
  player_brief_id uuid not null,
  understanding_id uuid not null,
  rank smallint not null,
  created_at timestamptz not null default now(),
  primary key (player_brief_id, understanding_id),
  constraint player_brief_understanding_brief_owner_fkey
    foreign key (player_brief_id, user_id)
    references public.player_briefs(id, user_id) on delete cascade,
  constraint player_brief_understanding_owner_fkey
    foreign key (understanding_id, user_id)
    references public.derived_understanding(id, user_id) on delete cascade
);

create table if not exists public.player_brief_signal_sources (
  user_id uuid not null references public.users(id) on delete cascade,
  player_brief_id uuid not null,
  signal_id uuid not null,
  rank smallint not null,
  created_at timestamptz not null default now(),
  primary key (player_brief_id, signal_id),
  constraint player_brief_signal_brief_owner_fkey
    foreign key (player_brief_id, user_id)
    references public.player_briefs(id, user_id) on delete cascade,
  constraint player_brief_signal_owner_fkey
    foreign key (signal_id, user_id)
    references public.player_signals(id, user_id) on delete cascade
);

alter table public.context_snapshots
  add column if not exists player_brief_id uuid;

alter table public.context_snapshots
  drop constraint if exists context_snapshots_player_brief_owner_fkey;
alter table public.context_snapshots
  add constraint context_snapshots_player_brief_owner_fkey
  foreign key (player_brief_id, user_id)
  references public.player_briefs(id, user_id) on delete set null;

create table if not exists public.understanding_delta_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  batch_key text not null,
  schema_version text not null,
  input_player_brief_id uuid not null,
  output_player_brief_id uuid,
  context_snapshot_id uuid,
  action_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint understanding_delta_batches_action_count_nonnegative check (action_count >= 0),
  constraint understanding_delta_batches_user_batch_key unique (user_id, batch_key),
  constraint understanding_delta_input_brief_owner_fkey
    foreign key (input_player_brief_id, user_id)
    references public.player_briefs(id, user_id) on delete restrict,
  constraint understanding_delta_output_brief_owner_fkey
    foreign key (output_player_brief_id, user_id)
    references public.player_briefs(id, user_id) on delete restrict,
  constraint understanding_delta_snapshot_owner_fkey
    foreign key (context_snapshot_id, user_id)
    references public.context_snapshots(id, user_id) on delete set null
);

create table if not exists public.understanding_transitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  delta_batch_id uuid not null references public.understanding_delta_batches(id) on delete cascade,
  action text not null,
  prior_understanding_id uuid,
  resulting_understanding_id uuid,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint understanding_transitions_action_check
    check (action in ('create','update','resolve','supersede')),
  constraint understanding_transition_prior_owner_fkey
    foreign key (prior_understanding_id, user_id)
    references public.derived_understanding(id, user_id) on delete cascade,
  constraint understanding_transition_result_owner_fkey
    foreign key (resulting_understanding_id, user_id)
    references public.derived_understanding(id, user_id) on delete cascade
);

create or replace function public.build_player_brief_json(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
with player as (
  select id, name, timezone
  from public.users
  where id = p_user_id
), ranked_understanding as (
  select
    u.*,
    row_number() over (
      partition by u.understanding_type
      order by u.importance desc, u.last_observed_at desc, u.id
    ) as type_rank
  from public.derived_understanding u
  where u.user_id = p_user_id
    and u.status = 'active'
), selected_understanding as (
  select *
  from ranked_understanding
  where type_rank <= 6
), highlights as (
  select *
  from public.derived_understanding u
  where u.user_id = p_user_id
    and u.status = 'active'
  order by u.importance desc, u.last_observed_at desc, u.id
  limit 6
), selected_signals as (
  select s.*
  from public.player_signals s
  where s.user_id = p_user_id
    and (s.expires_at is null or s.expires_at >= now())
  order by s.importance desc, s.observed_at desc, s.id
  limit 12
)
select jsonb_build_object(
  'schemaVersion', 'player-brief.v1',
  'generatedAt', now(),
  'player', jsonb_build_object(
    'id', player.id,
    'name', player.name,
    'timezone', player.timezone
  ),
  'activeUnderstandingIds', coalesce((
    select jsonb_agg(u.id order by u.importance desc, u.last_observed_at desc, u.id)
    from public.derived_understanding u
    where u.user_id = p_user_id and u.status = 'active'
  ), '[]'::jsonb),
  'highlights', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', h.id,
      'type', h.understanding_type,
      'summary', h.summary,
      'details', h.details,
      'confidence', h.confidence,
      'importance', h.importance,
      'firstObservedAt', h.first_observed_at,
      'lastObservedAt', h.last_observed_at
    ) order by h.importance desc, h.last_observed_at desc, h.id)
    from highlights h
  ), '[]'::jsonb),
  'sections', jsonb_build_object(
    'goals', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'details',details,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='goal'), '[]'::jsonb),
    'obstacles', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'details',details,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='obstacle'), '[]'::jsonb),
    'opportunities', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'details',details,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='opportunity'), '[]'::jsonb),
    'constraints', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'details',details,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='constraint'), '[]'::jsonb),
    'preferences', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'details',details,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='preference'), '[]'::jsonb),
    'relationships', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'details',details,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='relationship'), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'details',details,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='event'), '[]'::jsonb),
    'priorities', coalesce((select jsonb_agg(jsonb_build_object('id',id,'summary',summary,'details',details,'confidence',confidence,'importance',importance,'lastObservedAt',last_observed_at) order by importance desc,last_observed_at desc,id) from selected_understanding where understanding_type='priority'), '[]'::jsonb)
  ),
  'activeSignals', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id,
      'type', s.signal_type,
      'summary', s.summary,
      'importance', s.importance,
      'confidence', s.confidence,
      'observedAt', s.observed_at,
      'sourceUnderstandingId', s.source_understanding_id
    ) order by s.importance desc, s.observed_at desc, s.id)
    from selected_signals s
  ), '[]'::jsonb),
  'counts', jsonb_build_object(
    'activeUnderstanding', (select count(*) from public.derived_understanding u where u.user_id=p_user_id and u.status='active'),
    'activeSignals', (select count(*) from public.player_signals s where s.user_id=p_user_id and (s.expires_at is null or s.expires_at >= now()))
  )
)
from player;
$function$;

create or replace function public.refresh_player_brief_internal(
  p_user_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_version integer;
  v_brief jsonb;
  v_brief_id uuid;
begin
  perform 1 from public.users where id=p_user_id for update;
  if not found then raise exception 'Unknown player'; end if;

  select coalesce(max(version),0)+1
  into v_version
  from public.player_briefs
  where user_id=p_user_id;

  v_brief := public.build_player_brief_json(p_user_id);
  if v_brief is null then raise exception 'Could not build player brief'; end if;

  update public.player_briefs
  set is_current=false
  where user_id=p_user_id and is_current;

  insert into public.player_briefs(user_id,version,schema_version,brief,is_current,reason)
  values (p_user_id,v_version,'player-brief.v1',v_brief,true,coalesce(nullif(btrim(p_reason),''),'state_refresh'))
  returning id into v_brief_id;

  insert into public.player_brief_understanding_sources(user_id,player_brief_id,understanding_id,rank)
  select p_user_id,v_brief_id,id,row_number() over(order by importance desc,last_observed_at desc,id)::smallint
  from (
    select u.id,u.importance,u.last_observed_at,
           row_number() over(partition by u.understanding_type order by u.importance desc,u.last_observed_at desc,u.id) as type_rank
    from public.derived_understanding u
    where u.user_id=p_user_id and u.status='active'
  ) selected
  where selected.type_rank <= 6;

  insert into public.player_brief_signal_sources(user_id,player_brief_id,signal_id,rank)
  select p_user_id,v_brief_id,s.id,row_number() over(order by s.importance desc,s.observed_at desc,s.id)::smallint
  from (
    select ps.id,ps.importance,ps.observed_at
    from public.player_signals ps
    where ps.user_id=p_user_id
      and (ps.expires_at is null or ps.expires_at >= now())
    order by ps.importance desc,ps.observed_at desc,ps.id
    limit 12
  ) s;

  return v_brief_id;
end;
$function$;

create or replace function public.create_initial_player_brief()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists(select 1 from public.player_briefs where user_id=new.id and is_current) then
    perform public.refresh_player_brief_internal(new.id,'player_created');
  end if;
  return new;
end;
$function$;

drop trigger if exists users_create_initial_player_brief on public.users;
create trigger users_create_initial_player_brief
after insert on public.users
for each row execute function public.create_initial_player_brief();

create or replace function public.persist_understanding_delta(
  p_user_id uuid,
  p_actions jsonb,
  p_knowledge_entry_ids uuid[],
  p_signal_ids uuid[] default '{}'::uuid[],
  p_quest_result_ids uuid[] default '{}'::uuid[],
  p_active_quest_ids uuid[] default '{}'::uuid[],
  p_player_brief_id uuid default null,
  p_batch_key text default null,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'understanding-delta.v1',
  p_generated_at timestamptz default now(),
  p_retrieval jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.understanding_delta_batches%rowtype;
  v_snapshot_id uuid;
  v_delta_batch_id uuid;
  v_action jsonb;
  v_action_name text;
  v_target_id uuid;
  v_target public.derived_understanding%rowtype;
  v_new_id uuid;
  v_source_id uuid;
  v_reason text;
  v_relation text;
  v_action_count integer := 0;
  v_expected integer;
  v_actual integer;
  v_output_brief_id uuid;
  v_output_version integer;
  v_touched_targets uuid[] := '{}'::uuid[];
begin
  if not exists(select 1 from public.users where id=p_user_id) then raise exception 'Unknown player'; end if;
  if p_actions is null or jsonb_typeof(p_actions)<>'array' then raise exception 'Understanding delta actions must be an array'; end if;
  if p_knowledge_entry_ids is null or cardinality(p_knowledge_entry_ids)=0 then raise exception 'Understanding delta requires source knowledge'; end if;
  if coalesce(btrim(p_batch_key),'')='' then raise exception 'Understanding delta batch key is required'; end if;
  if p_retrieval is null or jsonb_typeof(p_retrieval)<>'object' then raise exception 'Retrieval metadata must be a JSON object'; end if;

  select * into v_existing
  from public.understanding_delta_batches
  where user_id=p_user_id and batch_key=p_batch_key;
  if found then
    select version into v_output_version from public.player_briefs where id=v_existing.output_player_brief_id and user_id=p_user_id;
    return jsonb_build_object(
      'deltaBatchId',v_existing.id,
      'actionCount',v_existing.action_count,
      'playerBriefId',v_existing.output_player_brief_id,
      'playerBriefVersion',v_output_version,
      'playerBriefChanged',v_existing.output_player_brief_id is distinct from v_existing.input_player_brief_id,
      'source','existing'
    );
  end if;

  if p_player_brief_id is null or not exists(
    select 1 from public.player_briefs
    where id=p_player_brief_id and user_id=p_user_id and is_current
  ) then
    raise exception 'Player brief changed before understanding delta persistence';
  end if;

  select count(*) into v_expected from (select distinct unnest(p_knowledge_entry_ids)) ids;
  select count(*) into v_actual from public.knowledge_entries where user_id=p_user_id and id=any(p_knowledge_entry_ids);
  if v_actual<>v_expected then raise exception 'Knowledge context contains missing or cross-player entries'; end if;

  select count(*) into v_expected from (select distinct unnest(coalesce(p_signal_ids,'{}'::uuid[]))) ids;
  select count(*) into v_actual from public.player_signals where user_id=p_user_id and id=any(coalesce(p_signal_ids,'{}'::uuid[]));
  if v_actual<>v_expected then raise exception 'Signal context contains missing or cross-player signals'; end if;

  select count(*) into v_expected from (select distinct unnest(coalesce(p_quest_result_ids,'{}'::uuid[]))) ids;
  select count(*) into v_actual from public.quest_results where user_id=p_user_id and id=any(coalesce(p_quest_result_ids,'{}'::uuid[]));
  if v_actual<>v_expected then raise exception 'Quest result context contains missing or cross-player results'; end if;

  select count(*) into v_expected from (select distinct unnest(coalesce(p_active_quest_ids,'{}'::uuid[]))) ids;
  select count(*) into v_actual from public.daily_quests where user_id=p_user_id and id=any(coalesce(p_active_quest_ids,'{}'::uuid[])) and status in ('pending','partial');
  if v_actual<>v_expected then raise exception 'Active quest context contains missing, inactive, or cross-player quests'; end if;

  insert into public.context_snapshots(
    user_id,purpose,summary,retrieval_metadata,generated_at,player_brief_id
  ) values (
    p_user_id,'understanding','Canonical Player Brief + bounded activity evidence',
    p_retrieval || jsonb_build_object('provider_id',p_provider_id,'model_id',p_model_id,'request_id',p_request_id,'schema_version',p_version),
    p_generated_at,p_player_brief_id
  ) returning id into v_snapshot_id;

  insert into public.context_snapshot_knowledge(user_id,snapshot_id,knowledge_entry_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,entry_id,ordinality::smallint,'activity window evidence'
  from unnest(p_knowledge_entry_ids) with ordinality as selected(entry_id,ordinality);

  insert into public.context_snapshot_signals(user_id,snapshot_id,signal_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,signal_id,ordinality::smallint,'active signal context'
  from unnest(coalesce(p_signal_ids,'{}'::uuid[])) with ordinality as selected(signal_id,ordinality);

  insert into public.context_snapshot_quest_results(user_id,snapshot_id,quest_result_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,result_id,ordinality::smallint,'recent quest outcome context'
  from unnest(coalesce(p_quest_result_ids,'{}'::uuid[])) with ordinality as selected(result_id,ordinality);

  insert into public.context_snapshot_quests(user_id,snapshot_id,quest_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,quest_id,ordinality::smallint,'current active quest context'
  from unnest(coalesce(p_active_quest_ids,'{}'::uuid[])) with ordinality as selected(quest_id,ordinality);

  insert into public.understanding_delta_batches(
    user_id,batch_key,schema_version,input_player_brief_id,context_snapshot_id
  ) values (
    p_user_id,p_batch_key,p_version,p_player_brief_id,v_snapshot_id
  ) returning id into v_delta_batch_id;

  for v_action in select value from jsonb_array_elements(p_actions) loop
    v_action_name := v_action->>'action';
    v_reason := btrim(coalesce(v_action->>'reason',''));
    if v_action_name not in ('create','update','resolve','supersede') then raise exception 'Unsupported understanding delta action'; end if;
    if v_reason='' then raise exception 'Understanding delta action reason is required'; end if;
    if not (v_action ? 'sourceKnowledgeEntryIds') or jsonb_typeof(v_action->'sourceKnowledgeEntryIds')<>'array' or jsonb_array_length(v_action->'sourceKnowledgeEntryIds')=0 then
      raise exception 'Understanding delta action requires sourceKnowledgeEntryIds';
    end if;

    for v_source_id in select value::text::uuid from jsonb_array_elements_text(v_action->'sourceKnowledgeEntryIds') loop
      if not (v_source_id=any(p_knowledge_entry_ids)) then raise exception 'Understanding delta references knowledge outside persisted context'; end if;
    end loop;

    v_target_id := null;
    if v_action_name in ('update','resolve','supersede') then
      if coalesce(v_action->>'targetUnderstandingId','')='' then raise exception 'Understanding delta targetUnderstandingId is required'; end if;
      v_target_id := (v_action->>'targetUnderstandingId')::uuid;
      if v_target_id=any(v_touched_targets) then raise exception 'Understanding delta cannot mutate the same target twice'; end if;
      v_touched_targets := array_append(v_touched_targets,v_target_id);
      select * into v_target from public.derived_understanding
      where id=v_target_id and user_id=p_user_id and status='active'
      for update;
      if not found then raise exception 'Understanding delta target is not an active understanding'; end if;
    end if;

    if v_action_name='resolve' then
      update public.derived_understanding
      set status='resolved',last_observed_at=p_generated_at,updated_at=now(),model_request_id=p_request_id
      where id=v_target_id and user_id=p_user_id;
      update public.player_signals
      set expires_at=coalesce(expires_at,p_generated_at)
      where user_id=p_user_id and source_understanding_id=v_target_id and (expires_at is null or expires_at>p_generated_at);
      insert into public.understanding_sources(user_id,understanding_id,knowledge_entry_id,relation_type,evidence_excerpt)
      select p_user_id,v_target_id,value::text::uuid,'updates',nullif(btrim(v_action->>'evidenceExcerpt'),'')
      from jsonb_array_elements_text(v_action->'sourceKnowledgeEntryIds')
      on conflict do nothing;
      insert into public.understanding_transitions(user_id,delta_batch_id,action,prior_understanding_id,resulting_understanding_id,reason)
      values (p_user_id,v_delta_batch_id,'resolve',v_target_id,null,v_reason);
      v_action_count := v_action_count + 1;
      continue;
    end if;

    if coalesce(v_action->>'type','') not in ('goal','obstacle','opportunity','constraint','preference','relationship','event','priority') then
      raise exception 'Understanding delta type is invalid';
    end if;
    if btrim(coalesce(v_action->>'summary',''))='' then raise exception 'Understanding delta summary is required'; end if;
    if not (v_action ? 'details') or jsonb_typeof(v_action->'details')<>'object' then raise exception 'Understanding delta details must be an object'; end if;
    if (v_action->>'confidence')::numeric < 0 or (v_action->>'confidence')::numeric > 1 then raise exception 'Understanding delta confidence must be between 0 and 1'; end if;
    if (v_action->>'importance')::integer not between 1 and 5 then raise exception 'Understanding delta importance must be between 1 and 5'; end if;

    if v_action_name in ('update','supersede') then
      update public.derived_understanding
      set status='superseded',last_observed_at=p_generated_at,updated_at=now(),model_request_id=p_request_id
      where id=v_target_id and user_id=p_user_id;
      update public.player_signals
      set expires_at=coalesce(expires_at,p_generated_at)
      where user_id=p_user_id and source_understanding_id=v_target_id and (expires_at is null or expires_at>p_generated_at);
    end if;

    insert into public.derived_understanding(
      user_id,understanding_type,summary,details,confidence,importance,status,
      first_observed_at,last_observed_at,extraction_version,provider_id,model_id,model_request_id
    ) values (
      p_user_id,v_action->>'type',btrim(v_action->>'summary'),v_action->'details',
      (v_action->>'confidence')::numeric,(v_action->>'importance')::smallint,'active',
      case when v_action_name='update' then v_target.first_observed_at else p_generated_at end,
      p_generated_at,p_version,p_provider_id,p_model_id,p_request_id
    ) returning id into v_new_id;

    v_relation := case when v_action_name='create' then 'origin' when v_action_name='update' then 'updates' else 'contradicts' end;
    insert into public.understanding_sources(user_id,understanding_id,knowledge_entry_id,relation_type,evidence_excerpt)
    select p_user_id,v_new_id,value::text::uuid,v_relation,nullif(btrim(v_action->>'evidenceExcerpt'),'')
    from jsonb_array_elements_text(v_action->'sourceKnowledgeEntryIds');

    insert into public.player_signals(user_id,source_understanding_id,signal_type,summary,importance,confidence,observed_at)
    values (
      p_user_id,v_new_id,v_action->>'type',btrim(v_action->>'summary'),
      (v_action->>'importance')::smallint,(v_action->>'confidence')::numeric,p_generated_at
    );

    insert into public.understanding_transitions(user_id,delta_batch_id,action,prior_understanding_id,resulting_understanding_id,reason)
    values (
      p_user_id,v_delta_batch_id,v_action_name,
      case when v_action_name='create' then null else v_target_id end,
      v_new_id,v_reason
    );
    v_action_count := v_action_count + 1;
  end loop;

  update public.knowledge_entries
  set processing_status='processed',processing_error=null,updated_at=now()
  where user_id=p_user_id and id=any(p_knowledge_entry_ids);

  update public.knowledge_sources source
  set processing_status='processed',processing_error=null,updated_at=now()
  where source.user_id=p_user_id
    and exists(select 1 from public.knowledge_entries selected where selected.source_id=source.id and selected.user_id=p_user_id and selected.id=any(p_knowledge_entry_ids))
    and not exists(select 1 from public.knowledge_entries remaining where remaining.source_id=source.id and remaining.user_id=p_user_id and remaining.processing_status not in ('processed','ignored'));

  if v_action_count > 0 then
    v_output_brief_id := public.refresh_player_brief_internal(p_user_id,'understanding_delta');
  else
    v_output_brief_id := p_player_brief_id;
  end if;

  update public.understanding_delta_batches
  set output_player_brief_id=v_output_brief_id,action_count=v_action_count
  where id=v_delta_batch_id;

  select version into v_output_version
  from public.player_briefs
  where id=v_output_brief_id and user_id=p_user_id;

  return jsonb_build_object(
    'deltaBatchId',v_delta_batch_id,
    'actionCount',v_action_count,
    'playerBriefId',v_output_brief_id,
    'playerBriefVersion',v_output_version,
    'playerBriefChanged',v_output_brief_id is distinct from p_player_brief_id,
    'source','persisted'
  );
end;
$function$;

alter table public.player_briefs enable row level security;
alter table public.player_brief_understanding_sources enable row level security;
alter table public.player_brief_signal_sources enable row level security;
alter table public.understanding_delta_batches enable row level security;
alter table public.understanding_transitions enable row level security;

drop policy if exists player_briefs_owner_select on public.player_briefs;
create policy player_briefs_owner_select on public.player_briefs
for select to authenticated using (user_id=auth.uid());

drop policy if exists player_brief_understanding_owner_select on public.player_brief_understanding_sources;
create policy player_brief_understanding_owner_select on public.player_brief_understanding_sources
for select to authenticated using (user_id=auth.uid());

drop policy if exists player_brief_signal_owner_select on public.player_brief_signal_sources;
create policy player_brief_signal_owner_select on public.player_brief_signal_sources
for select to authenticated using (user_id=auth.uid());

drop policy if exists understanding_delta_batches_owner_select on public.understanding_delta_batches;
create policy understanding_delta_batches_owner_select on public.understanding_delta_batches
for select to authenticated using (user_id=auth.uid());

drop policy if exists understanding_transitions_owner_select on public.understanding_transitions;
create policy understanding_transitions_owner_select on public.understanding_transitions
for select to authenticated using (user_id=auth.uid());

grant select on public.player_briefs to authenticated;
grant select on public.player_brief_understanding_sources to authenticated;
grant select on public.player_brief_signal_sources to authenticated;
grant select on public.understanding_delta_batches to authenticated;
grant select on public.understanding_transitions to authenticated;

grant select,insert,update,delete on public.player_briefs to service_role;
grant select,insert,update,delete on public.player_brief_understanding_sources to service_role;
grant select,insert,update,delete on public.player_brief_signal_sources to service_role;
grant select,insert,update,delete on public.understanding_delta_batches to service_role;
grant select,insert,update,delete on public.understanding_transitions to service_role;

revoke all on function public.refresh_player_brief_internal(uuid,text) from public,anon,authenticated;
revoke all on function public.create_initial_player_brief() from public,anon,authenticated;
revoke all on function public.persist_understanding_delta(uuid,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,text,text,text,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.persist_understanding_delta(uuid,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,text,text,text,text,timestamptz,jsonb) to service_role;

-- Backfill exactly one canonical brief for every existing player that does not have one.
do $block$
declare
  v_user_id uuid;
begin
  for v_user_id in select id from public.users loop
    if not exists(select 1 from public.player_briefs where user_id=v_user_id and is_current) then
      perform public.refresh_player_brief_internal(v_user_id,'migration_backfill');
    end if;
  end loop;
end
$block$;
