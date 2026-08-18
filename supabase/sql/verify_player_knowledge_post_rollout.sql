-- Read-only post-rollout report for the Life Vault / progression schema.
-- Run after the staged Player Knowledge + progression persistence migrations.

with expected_tables(table_name) as (
  values
    ('knowledge_sources'), ('knowledge_entries'), ('derived_understanding'),
    ('understanding_sources'), ('player_signals'), ('context_snapshots'),
    ('context_snapshot_signals'), ('context_snapshot_knowledge'),
    ('context_snapshot_quest_results'), ('quest_batches'), ('daily_quests'),
    ('quest_signal_sources'), ('quest_results')
), missing_tables as (
  select expected.table_name
  from expected_tables expected
  left join information_schema.tables actual
    on actual.table_schema = 'public' and actual.table_name = expected.table_name
  where actual.table_name is null
), rls_disabled as (
  select class.relname as table_name
  from pg_class class
  join pg_namespace namespace on namespace.oid = class.relnamespace
  where namespace.nspname = 'public'
    and class.relname in (select table_name from expected_tables)
    and class.relkind = 'r'
    and not class.relrowsecurity
), anon_grants as (
  select table_name, privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in (select table_name from expected_tables)
    and grantee = 'anon'
), anon_policies as (
  select tablename, policyname
  from pg_policies
  where schemaname = 'public'
    and tablename in (select table_name from expected_tables)
    and 'anon' = any(roles)
), sensitive_function_grants as (
  select routine_name, grantee, privilege_type
  from information_schema.routine_privileges
  where specific_schema = 'public'
    and routine_name in ('persist_derived_understanding', 'persist_daily_quest_batch')
    and grantee in ('anon', 'authenticated')
), ingestion_grants as (
  select grantee, privilege_type
  from information_schema.routine_privileges
  where specific_schema = 'public'
    and routine_name = 'ingest_manual_knowledge'
    and grantee in ('anon', 'authenticated')
)
select jsonb_build_object(
  'missing_tables', coalesce((select jsonb_agg(table_name order by table_name) from missing_tables), '[]'::jsonb),
  'rls_disabled_tables', coalesce((select jsonb_agg(table_name order by table_name) from rls_disabled), '[]'::jsonb),
  'anon_table_grants', coalesce((select jsonb_agg(to_jsonb(anon_grants)) from anon_grants), '[]'::jsonb),
  'anon_policies', coalesce((select jsonb_agg(to_jsonb(anon_policies)) from anon_policies), '[]'::jsonb),
  'sensitive_processing_grants_to_browser_roles', coalesce((select jsonb_agg(to_jsonb(sensitive_function_grants)) from sensitive_function_grants), '[]'::jsonb),
  'manual_ingestion_grants', coalesce((select jsonb_agg(to_jsonb(ingestion_grants)) from ingestion_grants), '[]'::jsonb),
  'one_batch_per_player_date', exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.quest_batches'::regclass
      and constraint_row.contype = 'u'
      and pg_get_constraintdef(constraint_row.oid) ilike '%user_id%quest_date%'
  ),
  'understanding_raw_provenance_fk', exists (
    select 1 from pg_constraint where conname = 'understanding_sources_knowledge_owner_fkey'
  ),
  'quest_signal_provenance_fk', exists (
    select 1 from pg_constraint where conname = 'quest_signal_sources_signal_owner_fkey'
  )
) as player_knowledge_security_report;
