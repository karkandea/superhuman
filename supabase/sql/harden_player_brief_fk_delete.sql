-- PostgreSQL 17 supports column-specific SET NULL for composite foreign keys.
-- Keep user_id intact when only the referenced snapshot/brief row disappears.

alter table public.context_snapshots
  drop constraint if exists context_snapshots_player_brief_owner_fkey;
alter table public.context_snapshots
  add constraint context_snapshots_player_brief_owner_fkey
  foreign key (player_brief_id, user_id)
  references public.player_briefs(id, user_id)
  on delete set null (player_brief_id);

alter table public.understanding_delta_batches
  drop constraint if exists understanding_delta_snapshot_owner_fkey;
alter table public.understanding_delta_batches
  add constraint understanding_delta_snapshot_owner_fkey
  foreign key (context_snapshot_id, user_id)
  references public.context_snapshots(id, user_id)
  on delete set null (context_snapshot_id);

revoke all on function public.build_player_brief_json(uuid) from public,anon,authenticated;
