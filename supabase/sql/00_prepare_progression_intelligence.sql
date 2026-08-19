-- Ownership key required by Progression Target composite foreign keys.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'daily_contexts_id_user_id_key'
      and conrelid = 'public.daily_contexts'::regclass
  ) then
    alter table public.daily_contexts
      add constraint daily_contexts_id_user_id_key unique (id, user_id);
  end if;
end
$$;
