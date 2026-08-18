-- Staged Life Vault / Player Knowledge foundation.
-- DO NOT apply until enforce_auth_ownership.sql has passed production verification.
-- Promote through the normal Supabase CLI migration workflow after the remote baseline exists.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'users_auth_user_fkey'
      and conrelid = 'public.users'::regclass
  ) then
    raise exception 'Life Vault rollout blocked: auth ownership FK is not installed';
  end if;

  if exists (
    select 1
    from public.users p
    left join auth.users a on a.id = p.id
    where a.id is null
  ) then
    raise exception 'Life Vault rollout blocked: at least one player is not linked to Supabase Auth';
  end if;

  if has_table_privilege('anon', 'public.users', 'select') then
    raise exception 'Life Vault rollout blocked: anonymous legacy access is still enabled';
  end if;
end
$$;

create table if not exists public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  source_type text not null check (source_type in (
    'life_update', 'note', 'journal', 'goal', 'relationship', 'career', 'wellness', 'document', 'integration'
  )),
  title text,
  external_ref text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz,
  processing_status text not null default 'pending' check (processing_status in ('pending', 'processing', 'processed', 'failed', 'ignored')),
  processing_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_sources_title_length check (title is null or char_length(title) <= 300),
  constraint knowledge_sources_metadata_object check (jsonb_typeof(metadata) = 'object'),
  unique (id, user_id)
);

create table if not exists public.knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  source_id uuid not null,
  entry_type text not null check (entry_type in (
    'life_update', 'note', 'journal', 'goal', 'relationship', 'career', 'wellness', 'document_text', 'event', 'other'
  )),
  raw_text text not null,
  content_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz,
  processing_status text not null default 'pending' check (processing_status in ('pending', 'processing', 'processed', 'failed', 'ignored')),
  processing_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_entries_raw_text_nonempty check (char_length(btrim(raw_text)) between 1 and 50000),
  constraint knowledge_entries_metadata_object check (jsonb_typeof(content_metadata) = 'object'),
  constraint knowledge_entries_source_owner_fkey
    foreign key (source_id, user_id)
    references public.knowledge_sources(id, user_id)
    on delete cascade,
  unique (id, user_id)
);

create table if not exists public.derived_understanding (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  understanding_type text not null check (understanding_type in (
    'goal', 'obstacle', 'opportunity', 'constraint', 'preference', 'relationship', 'event', 'priority'
  )),
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  status text not null default 'active' check (status in ('active', 'resolved', 'superseded', 'archived')),
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  extraction_version text not null,
  provider_id text,
  model_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint derived_understanding_summary_nonempty check (char_length(btrim(summary)) > 0),
  constraint derived_understanding_details_object check (jsonb_typeof(details) = 'object'),
  unique (id, user_id)
);

create table if not exists public.understanding_sources (
  user_id uuid not null references public.users(id) on delete cascade,
  understanding_id uuid not null,
  knowledge_entry_id uuid not null,
  relation_type text not null default 'origin' check (relation_type in ('origin', 'supports', 'contradicts', 'updates')),
  evidence_excerpt text,
  created_at timestamptz not null default now(),
  primary key (understanding_id, knowledge_entry_id, relation_type),
  constraint understanding_sources_understanding_owner_fkey
    foreign key (understanding_id, user_id)
    references public.derived_understanding(id, user_id)
    on delete cascade,
  constraint understanding_sources_knowledge_owner_fkey
    foreign key (knowledge_entry_id, user_id)
    references public.knowledge_entries(id, user_id)
    on delete cascade
);

create table if not exists public.player_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  source_understanding_id uuid,
  signal_type text not null check (signal_type in (
    'goal', 'obstacle', 'opportunity', 'constraint', 'preference', 'relationship', 'event', 'priority', 'energy'
  )),
  summary text not null,
  importance smallint not null default 3 check (importance between 1 and 5),
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  observed_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint player_signals_summary_nonempty check (char_length(btrim(summary)) > 0),
  constraint player_signals_understanding_owner_fkey
    foreign key (source_understanding_id, user_id)
    references public.derived_understanding(id, user_id)
    on delete cascade,
  unique (id, user_id)
);

create table if not exists public.context_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  context_date date,
  purpose text not null check (purpose in ('understanding', 'daily_quest', 'other')),
  summary text,
  retrieval_query text,
  retrieval_metadata jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  constraint context_snapshots_metadata_object check (jsonb_typeof(retrieval_metadata) = 'object'),
  unique (id, user_id)
);

create table if not exists public.context_snapshot_signals (
  user_id uuid not null references public.users(id) on delete cascade,
  snapshot_id uuid not null,
  signal_id uuid not null,
  rank smallint not null check (rank > 0),
  inclusion_reason text not null,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, signal_id),
  constraint context_snapshot_signals_snapshot_owner_fkey
    foreign key (snapshot_id, user_id)
    references public.context_snapshots(id, user_id)
    on delete cascade,
  constraint context_snapshot_signals_signal_owner_fkey
    foreign key (signal_id, user_id)
    references public.player_signals(id, user_id)
    on delete cascade
);

create table if not exists public.quest_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  quest_date date not null,
  context_snapshot_id uuid,
  status text not null default 'pending' check (status in ('pending', 'generated', 'failed')),
  provider_id text,
  model_id text,
  generation_version text not null,
  generation_metadata jsonb not null default '{}'::jsonb,
  generation_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint quest_batches_metadata_object check (jsonb_typeof(generation_metadata) = 'object'),
  constraint quest_batches_context_owner_fkey
    foreign key (context_snapshot_id, user_id)
    references public.context_snapshots(id, user_id)
    on delete restrict,
  unique (user_id, quest_date),
  unique (id, user_id)
);

create table if not exists public.daily_quests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  batch_id uuid,
  quest_date date not null,
  title text not null,
  category text not null check (category in ('pagi', 'siang', 'malam', 'sepanjang_hari')),
  kind text not null check (kind in ('main', 'side', 'maintenance', 'bonus')),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  priority smallint not null check (priority between 1 and 5),
  xp integer not null default 0 check (xp >= 0),
  rationale text,
  source text not null default 'ai' check (source in ('ai', 'legacy', 'system')),
  status text not null default 'pending' check (status in ('pending', 'completed', 'partial', 'skipped', 'failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint daily_quests_title_nonempty check (char_length(btrim(title)) > 0),
  constraint daily_quests_batch_owner_fkey
    foreign key (batch_id, user_id)
    references public.quest_batches(id, user_id)
    on delete restrict,
  unique (id, user_id)
);

create table if not exists public.quest_signal_sources (
  user_id uuid not null references public.users(id) on delete cascade,
  quest_id uuid not null,
  signal_id uuid not null,
  contribution_reason text,
  created_at timestamptz not null default now(),
  primary key (quest_id, signal_id),
  constraint quest_signal_sources_quest_owner_fkey
    foreign key (quest_id, user_id)
    references public.daily_quests(id, user_id)
    on delete cascade,
  constraint quest_signal_sources_signal_owner_fkey
    foreign key (signal_id, user_id)
    references public.player_signals(id, user_id)
    on delete restrict
);

create table if not exists public.quest_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  quest_id uuid not null,
  outcome text not null check (outcome in ('completed', 'partial', 'skipped', 'failed')),
  note text,
  result_data jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  constraint quest_results_data_object check (jsonb_typeof(result_data) = 'object'),
  constraint quest_results_quest_owner_fkey
    foreign key (quest_id, user_id)
    references public.daily_quests(id, user_id)
    on delete cascade,
  unique (quest_id)
);

create index if not exists knowledge_sources_user_created_idx on public.knowledge_sources(user_id, created_at desc);
create index if not exists knowledge_sources_user_status_idx on public.knowledge_sources(user_id, processing_status, created_at);
create index if not exists knowledge_entries_user_created_idx on public.knowledge_entries(user_id, created_at desc);
create index if not exists knowledge_entries_user_status_idx on public.knowledge_entries(user_id, processing_status, created_at);
create index if not exists derived_understanding_user_active_idx on public.derived_understanding(user_id, status, understanding_type, last_observed_at desc);
create index if not exists understanding_sources_user_knowledge_idx on public.understanding_sources(user_id, knowledge_entry_id);
create index if not exists player_signals_user_observed_idx on public.player_signals(user_id, observed_at desc);
create index if not exists player_signals_user_type_idx on public.player_signals(user_id, signal_type, importance desc);
create index if not exists context_snapshots_user_date_idx on public.context_snapshots(user_id, context_date desc, generated_at desc);
create index if not exists quest_batches_user_date_idx on public.quest_batches(user_id, quest_date desc);
create index if not exists daily_quests_user_date_idx on public.daily_quests(user_id, quest_date desc, priority);
create index if not exists quest_results_user_recorded_idx on public.quest_results(user_id, recorded_at desc);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'knowledge_sources', 'knowledge_entries', 'derived_understanding', 'understanding_sources',
    'player_signals', 'context_snapshots', 'context_snapshot_signals', 'quest_batches',
    'daily_quests', 'quest_signal_sources', 'quest_results'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon', table_name);
    execute format('revoke all on table public.%I from authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_select_own', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      table_name || '_select_own', table_name
    );
  end loop;
end
$$;

grant select on table public.knowledge_sources, public.knowledge_entries to authenticated;
grant insert (user_id, source_type, title, external_ref, metadata, occurred_at) on table public.knowledge_sources to authenticated;
grant insert (user_id, source_id, entry_type, raw_text, content_metadata, occurred_at) on table public.knowledge_entries to authenticated;
create policy knowledge_sources_insert_own on public.knowledge_sources for insert to authenticated with check ((select auth.uid()) = user_id);
create policy knowledge_entries_insert_own on public.knowledge_entries for insert to authenticated with check ((select auth.uid()) = user_id);

grant select on table public.derived_understanding, public.understanding_sources, public.player_signals,
  public.context_snapshots, public.context_snapshot_signals, public.quest_batches, public.quest_signal_sources to authenticated;

grant select on table public.daily_quests, public.quest_results to authenticated;
grant update (status, completed_at) on table public.daily_quests to authenticated;
grant insert (user_id, quest_id, outcome, note, result_data, recorded_at) on table public.quest_results to authenticated;
grant update (outcome, note, result_data, recorded_at) on table public.quest_results to authenticated;
create policy daily_quests_update_own on public.daily_quests for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy quest_results_insert_own on public.quest_results for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy quest_results_update_own on public.quest_results for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.ingest_manual_knowledge(
  p_entry_type text,
  p_raw_text text,
  p_title text default null,
  p_occurred_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_source_id uuid;
  v_entry_id uuid;
  v_text text := btrim(coalesce(p_raw_text, ''));
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_entry_type not in ('life_update', 'note', 'journal', 'goal', 'relationship', 'career', 'wellness') then
    raise exception 'Unsupported manual knowledge type';
  end if;

  if char_length(v_text) < 1 or char_length(v_text) > 50000 then
    raise exception 'Knowledge text must be between 1 and 50000 characters';
  end if;

  if p_title is not null and char_length(btrim(p_title)) > 300 then
    raise exception 'Knowledge title must be at most 300 characters';
  end if;

  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'Knowledge metadata must be a JSON object';
  end if;

  insert into public.knowledge_sources (user_id, source_type, title, metadata, occurred_at)
  values (v_user_id, p_entry_type, nullif(btrim(p_title), ''), p_metadata, p_occurred_at)
  returning id into v_source_id;

  insert into public.knowledge_entries (user_id, source_id, entry_type, raw_text, content_metadata, occurred_at)
  values (v_user_id, v_source_id, p_entry_type, v_text, p_metadata, p_occurred_at)
  returning id into v_entry_id;

  return v_entry_id;
end;
$$;

revoke execute on function public.ingest_manual_knowledge(text, text, text, timestamptz, jsonb) from public;
revoke execute on function public.ingest_manual_knowledge(text, text, text, timestamptz, jsonb) from anon;
grant execute on function public.ingest_manual_knowledge(text, text, text, timestamptz, jsonb) to authenticated;
grant execute on function public.ingest_manual_knowledge(text, text, text, timestamptz, jsonb) to service_role;
