-- Staged security rollout for the existing Superhuman schema.
-- Promote this file into a timestamped Supabase migration with `supabase migration new`
-- before applying it through the normal migration workflow.
--
-- IMPORTANT: Provision Supabase Auth users first with IDs matching public.users.id.
-- The guard below aborts before any access-policy changes if even one legacy player is unlinked.

do $$
begin
  if exists (
    select 1
    from public.users as player
    left join auth.users as auth_user on auth_user.id = player.id
    where auth_user.id is null
  ) then
    raise exception 'Auth ownership rollout blocked: every public.users.id must first exist in auth.users with the same UUID';
  end if;
end
$$;

-- Lock the ownership model structurally after every legacy player is linked.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_auth_user_fkey'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_auth_user_fkey
      foreign key (id) references auth.users(id)
      on delete restrict;
  end if;
end
$$;

alter table public.users enable row level security;
alter table public.checklist_items enable row level security;
alter table public.daily_logs enable row level security;
alter table public.time_slots enable row level security;
alter table public.weekly_goals enable row level security;
alter table public.weekly_progress enable row level security;

-- Remove legacy username/anon access.
drop policy if exists anon_insert_users on public.users;
drop policy if exists anon_select_users on public.users;

drop policy if exists anon_insert_items on public.checklist_items;
drop policy if exists anon_select_items on public.checklist_items;
drop policy if exists anon_update_items on public.checklist_items;

drop policy if exists anon_insert_logs on public.daily_logs;
drop policy if exists anon_select_logs on public.daily_logs;
drop policy if exists anon_update_logs on public.daily_logs;

drop policy if exists anon_manage_time_slots on public.time_slots;
drop policy if exists anon_manage_weekly_goals on public.weekly_goals;
drop policy if exists anon_manage_weekly_progress on public.weekly_progress;

-- Also clean up target policy names so a retry is deterministic.
drop policy if exists users_select_own on public.users;
drop policy if exists users_update_own on public.users;
drop policy if exists checklist_items_select_own on public.checklist_items;
drop policy if exists checklist_items_insert_own on public.checklist_items;
drop policy if exists checklist_items_update_own on public.checklist_items;
drop policy if exists checklist_items_delete_own on public.checklist_items;
drop policy if exists daily_logs_select_own on public.daily_logs;
drop policy if exists daily_logs_insert_own on public.daily_logs;
drop policy if exists daily_logs_update_own on public.daily_logs;
drop policy if exists time_slots_select_own on public.time_slots;
drop policy if exists time_slots_insert_own on public.time_slots;
drop policy if exists time_slots_update_own on public.time_slots;
drop policy if exists time_slots_delete_own on public.time_slots;
drop policy if exists weekly_goals_select_own on public.weekly_goals;
drop policy if exists weekly_goals_insert_own on public.weekly_goals;
drop policy if exists weekly_goals_update_own on public.weekly_goals;
drop policy if exists weekly_goals_delete_own on public.weekly_goals;
drop policy if exists weekly_progress_select_own on public.weekly_progress;
drop policy if exists weekly_progress_insert_own on public.weekly_progress;
drop policy if exists weekly_progress_update_own on public.weekly_progress;
drop policy if exists weekly_progress_delete_own on public.weekly_progress;

revoke all on table public.users from anon;
revoke all on table public.checklist_items from anon;
revoke all on table public.daily_logs from anon;
revoke all on table public.time_slots from anon;
revoke all on table public.weekly_goals from anon;
revoke all on table public.weekly_progress from anon;

-- Reset authenticated privileges too, then grant only what the current app needs.
revoke all on table public.users from authenticated;
revoke all on table public.checklist_items from authenticated;
revoke all on table public.daily_logs from authenticated;
revoke all on table public.time_slots from authenticated;
revoke all on table public.weekly_goals from authenticated;
revoke all on table public.weekly_progress from authenticated;

-- The browser only receives the publishable/anon key. Authenticated JWT + RLS carries authorization.
grant select, update on table public.users to authenticated;
grant select, insert, update, delete on table public.checklist_items to authenticated;
grant select, insert, update on table public.daily_logs to authenticated;
grant select, insert, update, delete on table public.time_slots to authenticated;
grant select, insert, update, delete on table public.weekly_goals to authenticated;
grant select, insert, update, delete on table public.weekly_progress to authenticated;

create policy users_select_own
on public.users
for select
to authenticated
using ((select auth.uid()) = id);

create policy users_update_own
on public.users
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy checklist_items_select_own
on public.checklist_items
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy checklist_items_insert_own
on public.checklist_items
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy checklist_items_update_own
on public.checklist_items
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy checklist_items_delete_own
on public.checklist_items
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy daily_logs_select_own
on public.daily_logs
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy daily_logs_insert_own
on public.daily_logs
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy daily_logs_update_own
on public.daily_logs
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy time_slots_select_own
on public.time_slots
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy time_slots_insert_own
on public.time_slots
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy time_slots_update_own
on public.time_slots
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy time_slots_delete_own
on public.time_slots
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy weekly_goals_select_own
on public.weekly_goals
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy weekly_goals_insert_own
on public.weekly_goals
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy weekly_goals_update_own
on public.weekly_goals
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy weekly_goals_delete_own
on public.weekly_goals
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy weekly_progress_select_own
on public.weekly_progress
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy weekly_progress_insert_own
on public.weekly_progress
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy weekly_progress_update_own
on public.weekly_progress
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy weekly_progress_delete_own
on public.weekly_progress
for delete
to authenticated
using ((select auth.uid()) = user_id);
