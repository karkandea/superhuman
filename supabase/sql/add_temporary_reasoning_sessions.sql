begin;

create table if not exists public.ai_reasoning_sessions (
  user_id uuid not null references public.users(id) on delete cascade,
  phase_key text not null check (char_length(btrim(phase_key)) between 1 and 120),
  status text not null default 'active' check (status in ('active','closed')),
  provider_id text not null check (char_length(btrim(provider_id)) between 1 and 120),
  conversation_ref text check (conversation_ref is null or char_length(btrim(conversation_ref)) between 1 and 240),
  temporary_chat boolean not null default true,
  started_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(user_id,phase_key)
);

comment on table public.ai_reasoning_sessions is
  'Worker-only provider session continuity. Supabase remains canonical player memory; provider rooms are temporary phase-local working context only.';

alter table public.ai_reasoning_sessions enable row level security;

revoke all on public.ai_reasoning_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.ai_reasoning_sessions to service_role;

create index if not exists ai_reasoning_sessions_active_idx
  on public.ai_reasoning_sessions(status,phase_key,last_used_at desc)
  where status='active';

commit;
