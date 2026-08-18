-- Staged atomic persistence for Player Understanding + Daily Quest progression.
-- Apply only after create_player_knowledge_foundation.sql and only after Auth/RLS hardening passes.

alter table public.derived_understanding
  add column if not exists model_request_id text;

alter table public.quest_batches
  add column if not exists model_request_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quest_results_id_user_id_key'
      and conrelid = 'public.quest_results'::regclass
  ) then
    alter table public.quest_results
      add constraint quest_results_id_user_id_key unique (id, user_id);
  end if;
end
$$;

create table if not exists public.context_snapshot_knowledge (
  user_id uuid not null references public.users(id) on delete cascade,
  snapshot_id uuid not null,
  knowledge_entry_id uuid not null,
  rank smallint not null check (rank > 0),
  inclusion_reason text not null,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, knowledge_entry_id),
  constraint context_snapshot_knowledge_snapshot_owner_fkey
    foreign key (snapshot_id, user_id)
    references public.context_snapshots(id, user_id)
    on delete cascade,
  constraint context_snapshot_knowledge_entry_owner_fkey
    foreign key (knowledge_entry_id, user_id)
    references public.knowledge_entries(id, user_id)
    on delete cascade
);

create table if not exists public.context_snapshot_quest_results (
  user_id uuid not null references public.users(id) on delete cascade,
  snapshot_id uuid not null,
  quest_result_id uuid not null,
  rank smallint not null check (rank > 0),
  inclusion_reason text not null,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, quest_result_id),
  constraint context_snapshot_quest_results_snapshot_owner_fkey
    foreign key (snapshot_id, user_id)
    references public.context_snapshots(id, user_id)
    on delete cascade,
  constraint context_snapshot_quest_results_result_owner_fkey
    foreign key (quest_result_id, user_id)
    references public.quest_results(id, user_id)
    on delete cascade
);

create index if not exists context_snapshot_knowledge_user_entry_idx
  on public.context_snapshot_knowledge(user_id, knowledge_entry_id);
create index if not exists context_snapshot_quest_results_user_result_idx
  on public.context_snapshot_quest_results(user_id, quest_result_id);

alter table public.context_snapshot_knowledge enable row level security;
alter table public.context_snapshot_quest_results enable row level security;

revoke all on table public.context_snapshot_knowledge from anon, authenticated;
revoke all on table public.context_snapshot_quest_results from anon, authenticated;
grant select, insert, update, delete on table public.context_snapshot_knowledge to service_role;
grant select, insert, update, delete on table public.context_snapshot_quest_results to service_role;
grant select on table public.context_snapshot_knowledge, public.context_snapshot_quest_results to authenticated;

drop policy if exists context_snapshot_knowledge_select_own on public.context_snapshot_knowledge;
create policy context_snapshot_knowledge_select_own
on public.context_snapshot_knowledge for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists context_snapshot_quest_results_select_own on public.context_snapshot_quest_results;
create policy context_snapshot_quest_results_select_own
on public.context_snapshot_quest_results for select to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.persist_derived_understanding(
  p_user_id uuid,
  p_candidates jsonb,
  p_knowledge_entry_ids uuid[],
  p_signal_ids uuid[] default '{}'::uuid[],
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'understanding.v1',
  p_generated_at timestamptz default now(),
  p_retrieval jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_snapshot_id uuid;
  v_candidate jsonb;
  v_understanding_id uuid;
  v_source_id uuid;
  v_expected integer;
  v_actual integer;
begin
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'Unknown player';
  end if;

  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) = 0 then
    raise exception 'At least one understanding candidate is required';
  end if;

  if p_knowledge_entry_ids is null or cardinality(p_knowledge_entry_ids) = 0 then
    raise exception 'Understanding persistence requires source knowledge';
  end if;

  if p_retrieval is null or jsonb_typeof(p_retrieval) <> 'object' then
    raise exception 'Retrieval metadata must be a JSON object';
  end if;

  select count(*) into v_expected from (select distinct unnest(p_knowledge_entry_ids)) ids;
  select count(*) into v_actual
  from public.knowledge_entries
  where user_id = p_user_id and id = any(p_knowledge_entry_ids);
  if v_actual <> v_expected then
    raise exception 'Knowledge context contains missing or cross-player entries';
  end if;

  select count(*) into v_expected from (select distinct unnest(coalesce(p_signal_ids, '{}'::uuid[]))) ids;
  select count(*) into v_actual
  from public.player_signals
  where user_id = p_user_id and id = any(coalesce(p_signal_ids, '{}'::uuid[]));
  if v_actual <> v_expected then
    raise exception 'Signal context contains missing or cross-player signals';
  end if;

  insert into public.context_snapshots (
    user_id, purpose, summary, retrieval_metadata, generated_at
  ) values (
    p_user_id,
    'understanding',
    'Evidence selected for understanding extraction',
    p_retrieval || jsonb_build_object(
      'provider_id', p_provider_id,
      'model_id', p_model_id,
      'request_id', p_request_id,
      'schema_version', p_version
    ),
    p_generated_at
  ) returning id into v_snapshot_id;

  insert into public.context_snapshot_knowledge (
    user_id, snapshot_id, knowledge_entry_id, rank, inclusion_reason
  )
  select p_user_id, v_snapshot_id, entry_id, ordinality::smallint, 'selected raw knowledge'
  from unnest(p_knowledge_entry_ids) with ordinality as selected(entry_id, ordinality);

  insert into public.context_snapshot_signals (
    user_id, snapshot_id, signal_id, rank, inclusion_reason
  )
  select p_user_id, v_snapshot_id, signal_id, ordinality::smallint, 'recent derived context'
  from unnest(coalesce(p_signal_ids, '{}'::uuid[])) with ordinality as selected(signal_id, ordinality);

  for v_candidate in select value from jsonb_array_elements(p_candidates)
  loop
    if coalesce(v_candidate->>'summary', '') = '' then
      raise exception 'Understanding candidate summary is required';
    end if;

    if not (v_candidate ? 'sourceKnowledgeEntryIds')
       or jsonb_typeof(v_candidate->'sourceKnowledgeEntryIds') <> 'array'
       or jsonb_array_length(v_candidate->'sourceKnowledgeEntryIds') = 0 then
      raise exception 'Understanding candidate requires sourceKnowledgeEntryIds';
    end if;

    if (v_candidate->>'importance')::integer not between 1 and 5 then
      raise exception 'Understanding importance must be between 1 and 5';
    end if;

    for v_source_id in
      select value::text::uuid
      from jsonb_array_elements_text(v_candidate->'sourceKnowledgeEntryIds')
    loop
      if not (v_source_id = any(p_knowledge_entry_ids))
         or not exists (
           select 1 from public.knowledge_entries
           where id = v_source_id and user_id = p_user_id
         ) then
        raise exception 'Understanding candidate references knowledge outside persisted context';
      end if;
    end loop;

    insert into public.derived_understanding (
      user_id,
      understanding_type,
      summary,
      details,
      confidence,
      extraction_version,
      provider_id,
      model_id,
      model_request_id,
      first_observed_at,
      last_observed_at
    ) values (
      p_user_id,
      v_candidate->>'type',
      btrim(v_candidate->>'summary'),
      coalesce(v_candidate->'details', '{}'::jsonb),
      (v_candidate->>'confidence')::numeric,
      p_version,
      p_provider_id,
      p_model_id,
      p_request_id,
      p_generated_at,
      p_generated_at
    ) returning id into v_understanding_id;

    insert into public.understanding_sources (
      user_id, understanding_id, knowledge_entry_id, relation_type, evidence_excerpt
    )
    select
      p_user_id,
      v_understanding_id,
      value::text::uuid,
      'origin',
      nullif(btrim(v_candidate->>'evidenceExcerpt'), '')
    from jsonb_array_elements_text(v_candidate->'sourceKnowledgeEntryIds');

    insert into public.player_signals (
      user_id,
      source_understanding_id,
      signal_type,
      summary,
      importance,
      confidence,
      observed_at
    ) values (
      p_user_id,
      v_understanding_id,
      v_candidate->>'type',
      btrim(v_candidate->>'summary'),
      (v_candidate->>'importance')::smallint,
      (v_candidate->>'confidence')::numeric,
      p_generated_at
    );
  end loop;

  update public.knowledge_entries
  set processing_status = 'processed', processing_error = null, updated_at = now()
  where user_id = p_user_id and id = any(p_knowledge_entry_ids);

  update public.knowledge_sources source
  set processing_status = 'processed', processing_error = null, updated_at = now()
  where source.user_id = p_user_id
    and exists (
      select 1 from public.knowledge_entries selected
      where selected.source_id = source.id
        and selected.user_id = p_user_id
        and selected.id = any(p_knowledge_entry_ids)
    )
    and not exists (
      select 1 from public.knowledge_entries remaining
      where remaining.source_id = source.id
        and remaining.user_id = p_user_id
        and remaining.processing_status not in ('processed', 'ignored')
    );

  return v_snapshot_id;
end;
$$;

revoke execute on function public.persist_derived_understanding(uuid, jsonb, uuid[], uuid[], text, text, text, text, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_derived_understanding(uuid, jsonb, uuid[], uuid[], text, text, text, text, timestamptz, jsonb)
  to service_role;

create or replace function public.persist_daily_quest_batch(
  p_user_id uuid,
  p_quest_date date,
  p_signal_ids uuid[],
  p_quest_result_ids uuid[] default '{}'::uuid[],
  p_quests jsonb default '[]'::jsonb,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'daily-quest.v1',
  p_generated_at timestamptz default now(),
  p_retrieval jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch_id uuid;
  v_snapshot_id uuid;
  v_quest jsonb;
  v_quest_id uuid;
  v_signal_id uuid;
  v_expected integer;
  v_actual integer;
begin
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'Unknown player';
  end if;

  if p_signal_ids is null or cardinality(p_signal_ids) = 0 then
    raise exception 'Daily Quest persistence requires evidence-backed signals';
  end if;

  if p_quests is null or jsonb_typeof(p_quests) <> 'array' or jsonb_array_length(p_quests) = 0 then
    raise exception 'At least one quest is required';
  end if;

  if p_retrieval is null or jsonb_typeof(p_retrieval) <> 'object' then
    raise exception 'Retrieval metadata must be a JSON object';
  end if;

  select count(*) into v_expected from (select distinct unnest(p_signal_ids)) ids;
  select count(*) into v_actual
  from public.player_signals
  where user_id = p_user_id and id = any(p_signal_ids);
  if v_actual <> v_expected then
    raise exception 'Quest context contains missing or cross-player signals';
  end if;

  select count(*) into v_expected from (select distinct unnest(coalesce(p_quest_result_ids, '{}'::uuid[]))) ids;
  select count(*) into v_actual
  from public.quest_results
  where user_id = p_user_id and id = any(coalesce(p_quest_result_ids, '{}'::uuid[]));
  if v_actual <> v_expected then
    raise exception 'Quest result context contains missing or cross-player results';
  end if;

  insert into public.quest_batches (
    user_id,
    quest_date,
    status,
    provider_id,
    model_id,
    model_request_id,
    generation_version,
    generation_metadata
  ) values (
    p_user_id,
    p_quest_date,
    'pending',
    p_provider_id,
    p_model_id,
    p_request_id,
    p_version,
    p_retrieval
  )
  on conflict (user_id, quest_date) do nothing
  returning id into v_batch_id;

  if v_batch_id is null then
    return (
      select coalesce(jsonb_agg(
        to_jsonb(quest) || jsonb_build_object(
          'source_signal_ids', coalesce((
            select jsonb_agg(link.signal_id order by link.created_at)
            from public.quest_signal_sources link
            where link.quest_id = quest.id and link.user_id = p_user_id
          ), '[]'::jsonb)
        ) order by quest.priority, quest.created_at
      ), '[]'::jsonb)
      from public.daily_quests quest
      where quest.user_id = p_user_id and quest.quest_date = p_quest_date
    );
  end if;

  insert into public.context_snapshots (
    user_id, context_date, purpose, summary, retrieval_metadata, generated_at
  ) values (
    p_user_id,
    p_quest_date,
    'daily_quest',
    'Bounded context used for Daily Quest generation',
    p_retrieval || jsonb_build_object(
      'provider_id', p_provider_id,
      'model_id', p_model_id,
      'request_id', p_request_id,
      'schema_version', p_version
    ),
    p_generated_at
  ) returning id into v_snapshot_id;

  insert into public.context_snapshot_signals (
    user_id, snapshot_id, signal_id, rank, inclusion_reason
  )
  select p_user_id, v_snapshot_id, signal_id, ordinality::smallint, 'active player signal'
  from unnest(p_signal_ids) with ordinality as selected(signal_id, ordinality);

  insert into public.context_snapshot_quest_results (
    user_id, snapshot_id, quest_result_id, rank, inclusion_reason
  )
  select p_user_id, v_snapshot_id, result_id, ordinality::smallint, 'recent quest outcome'
  from unnest(coalesce(p_quest_result_ids, '{}'::uuid[])) with ordinality as selected(result_id, ordinality);

  update public.quest_batches
  set context_snapshot_id = v_snapshot_id
  where id = v_batch_id and user_id = p_user_id;

  for v_quest in select value from jsonb_array_elements(p_quests)
  loop
    if coalesce(v_quest->>'title', '') = '' or coalesce(v_quest->>'rationale', '') = '' then
      raise exception 'Quest title and rationale are required';
    end if;

    if not (v_quest ? 'sourceSignalIds')
       or jsonb_typeof(v_quest->'sourceSignalIds') <> 'array'
       or jsonb_array_length(v_quest->'sourceSignalIds') = 0 then
      raise exception 'Quest requires sourceSignalIds';
    end if;

    for v_signal_id in
      select value::text::uuid
      from jsonb_array_elements_text(v_quest->'sourceSignalIds')
    loop
      if not (v_signal_id = any(p_signal_ids))
         or not exists (
           select 1 from public.player_signals
           where id = v_signal_id and user_id = p_user_id
         ) then
        raise exception 'Quest references a signal outside persisted context';
      end if;
    end loop;

    insert into public.daily_quests (
      user_id,
      batch_id,
      quest_date,
      title,
      category,
      kind,
      difficulty,
      priority,
      xp,
      rationale,
      source,
      status
    ) values (
      p_user_id,
      v_batch_id,
      p_quest_date,
      btrim(v_quest->>'title'),
      v_quest->>'category',
      v_quest->>'kind',
      v_quest->>'difficulty',
      (v_quest->>'priority')::smallint,
      (v_quest->>'xp')::integer,
      btrim(v_quest->>'rationale'),
      'ai',
      'pending'
    ) returning id into v_quest_id;

    insert into public.quest_signal_sources (
      user_id, quest_id, signal_id, contribution_reason
    )
    select
      p_user_id,
      v_quest_id,
      value::text::uuid,
      btrim(v_quest->>'rationale')
    from jsonb_array_elements_text(v_quest->'sourceSignalIds');
  end loop;

  update public.quest_batches
  set status = 'generated', generation_error = null
  where id = v_batch_id and user_id = p_user_id;

  return (
    select coalesce(jsonb_agg(
      to_jsonb(quest) || jsonb_build_object(
        'source_signal_ids', coalesce((
          select jsonb_agg(link.signal_id order by link.created_at)
          from public.quest_signal_sources link
          where link.quest_id = quest.id and link.user_id = p_user_id
        ), '[]'::jsonb)
      ) order by quest.priority, quest.created_at
    ), '[]'::jsonb)
    from public.daily_quests quest
    where quest.user_id = p_user_id and quest.quest_date = p_quest_date
  );
end;
$$;

revoke execute on function public.persist_daily_quest_batch(uuid, date, uuid[], uuid[], jsonb, text, text, text, text, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_daily_quest_batch(uuid, date, uuid[], uuid[], jsonb, text, text, text, text, timestamptz, jsonb)
  to service_role;
