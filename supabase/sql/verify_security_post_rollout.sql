-- Read-only post-rollout verification report.
-- Expected PASS state: every player has same-UUID Auth, FK exists, RLS is on,
-- and anon has neither policies nor table grants on the legacy surface.

with legacy_tables(table_name) as (
  values ('users'), ('checklist_items'), ('daily_logs'), ('time_slots'), ('weekly_goals'), ('weekly_progress')
), missing_auth as (
  select p.id, p.name
  from public.users p
  left join auth.users a on a.id = p.id
  where a.id is null
), anon_policies as (
  select tablename, policyname
  from pg_policies
  where schemaname = 'public'
    and tablename in (select table_name from legacy_tables)
    and 'anon' = any(roles)
), anon_grants as (
  select table_name, privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in (select table_name from legacy_tables)
    and grantee = 'anon'
), rls_disabled as (
  select c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (select table_name from legacy_tables)
    and c.relkind = 'r'
    and not c.relrowsecurity
), owner_policy_count as (
  select count(*)::int as count
  from pg_policies
  where schemaname = 'public'
    and tablename in (select table_name from legacy_tables)
    and 'authenticated' = any(roles)
)
select jsonb_build_object(
  'public_player_count', (select count(*) from public.users),
  'auth_user_count', (select count(*) from auth.users),
  'missing_auth_players', coalesce((select jsonb_agg(to_jsonb(missing_auth)) from missing_auth), '[]'::jsonb),
  'auth_fk_present', exists(select 1 from pg_constraint where conname = 'users_auth_user_fkey' and conrelid = 'public.users'::regclass),
  'rls_disabled_tables', coalesce((select jsonb_agg(table_name order by table_name) from rls_disabled), '[]'::jsonb),
  'anon_policies', coalesce((select jsonb_agg(to_jsonb(anon_policies)) from anon_policies), '[]'::jsonb),
  'anon_grants', coalesce((select jsonb_agg(to_jsonb(anon_grants)) from anon_grants), '[]'::jsonb),
  'authenticated_owner_policy_count', (select count from owner_policy_count)
) as security_report;
