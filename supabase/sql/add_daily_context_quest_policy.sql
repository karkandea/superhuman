-- Daily Context is temporary per-day state used only before the first Daily Quest batch.
-- It is intentionally separate from Life Vault / permanent player understanding.

create table if not exists public.daily_contexts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  context_date date not null,
  mode text not null check (mode in ('normal','context')),
  context_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_contexts_user_date_key unique (user_id, context_date),
  constraint daily_contexts_mode_text_check check (
    (mode='normal' and btrim(context_text)='')
    or (mode='context' and btrim(context_text)<>'')
  ),
  constraint daily_contexts_text_budget_check check (octet_length(convert_to(context_text,'UTF8')) <= 4096)
);

create index if not exists daily_contexts_user_date_idx
  on public.daily_contexts(user_id, context_date desc);

alter table public.daily_contexts enable row level security;

revoke all on table public.daily_contexts from anon, authenticated;
grant select on table public.daily_contexts to authenticated;
grant select, insert, update, delete on table public.daily_contexts to service_role;

drop policy if exists daily_contexts_select_own on public.daily_contexts;
create policy daily_contexts_select_own
on public.daily_contexts for select to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.submit_daily_context(
  p_target_date date,
  p_mode text,
  p_context_text text default null
)
returns public.daily_contexts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_timezone text;
  v_local_date date;
  v_text text := btrim(coalesce(p_context_text,''));
  v_context public.daily_contexts;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if not exists(select 1 from public.users where id=v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode='42501';
  end if;
  if p_target_date is null then raise exception 'target date is required'; end if;
  if p_mode not in ('normal','context') then raise exception 'Unsupported Daily Context mode'; end if;

  select timezone into v_timezone from public.users where id=v_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_local_date := (now() at time zone v_timezone)::date;
  if p_target_date <> v_local_date then
    raise exception 'Daily Context can only be confirmed for the player current local day';
  end if;

  if exists(select 1 from public.daily_quests where user_id=v_user_id and quest_date=p_target_date) then
    raise exception 'Daily Context is locked after Daily Quest generation; use a Life Vault update instead';
  end if;

  if p_mode='normal' and v_text<>'' then raise exception 'Normal-day check-in cannot contain custom context'; end if;
  if p_mode='context' and v_text='' then raise exception 'Tell the System what is different today'; end if;
  if octet_length(convert_to(v_text,'UTF8')) > 4096 then raise exception 'Daily Context exceeds 4 KB'; end if;

  insert into public.daily_contexts(user_id,context_date,mode,context_text)
  values(v_user_id,p_target_date,p_mode,v_text)
  on conflict(user_id,context_date) do update
  set mode=excluded.mode,
      context_text=excluded.context_text,
      updated_at=now()
  returning * into v_context;

  return v_context;
end;
$$;

revoke execute on function public.submit_daily_context(date,text,text) from public, anon;
grant execute on function public.submit_daily_context(date,text,text) to authenticated;

-- Manual quest generation is also gated. Knowledge ingestion can still process before check-in;
-- worker-v2 will persist understanding and then stop at awaiting_daily_context instead of generating quests.
create or replace function public.request_progression_cycle(p_target_date date)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_job public.ai_inference_jobs;
  v_has_quests boolean;
  v_has_daily_context boolean;
  v_has_pending_knowledge boolean;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_target_date is null then raise exception 'target date is required'; end if;
  if not exists (select 1 from public.users where id = v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode = '42501';
  end if;

  select exists(select 1 from public.daily_quests where user_id=v_user_id and quest_date=p_target_date) into v_has_quests;
  select exists(select 1 from public.daily_contexts where user_id=v_user_id and context_date=p_target_date) into v_has_daily_context;
  if not v_has_quests and not v_has_daily_context then
    raise exception 'Daily Context check-in required before first Daily Quest generation';
  end if;

  select exists(select 1 from public.knowledge_entries where user_id=v_user_id and processing_status in ('pending','failed')) into v_has_pending_knowledge;

  insert into public.ai_inference_jobs(
    user_id,operation,target_date,status,completed_at,activity_window_started_at,window_cutoff_at
  ) values (
    v_user_id,'progression_cycle',p_target_date,
    case when v_has_quests and not v_has_pending_knowledge then 'succeeded' else 'queued' end,
    case when v_has_quests and not v_has_pending_knowledge then now() else null end,
    case when v_has_pending_knowledge then now() else null end,
    null
  )
  on conflict (user_id,operation,target_date) do update
  set status = case
        when public.ai_inference_jobs.status='running' then 'running'
        when v_has_quests and not v_has_pending_knowledge then 'succeeded'
        else 'queued' end,
      rerun_requested = case when public.ai_inference_jobs.status='running' and v_has_pending_knowledge then true else false end,
      correlation_id = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.correlation_id else gen_random_uuid() end,
      attempt_count = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.attempt_count else 0 end,
      available_at = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.available_at else now() end,
      lease_expires_at = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.lease_expires_at else null end,
      worker_id = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.worker_id else null end,
      provider_id = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_id else null end,
      provider_conversation_refs = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_conversation_refs else '[]'::jsonb end,
      result_summary = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.result_summary else '{}'::jsonb end,
      error_code = null,
      error_message = null,
      started_at = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.started_at else null end,
      completed_at = case
        when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.completed_at
        when v_has_quests and not v_has_pending_knowledge then now()
        else null end,
      activity_window_started_at = case
        when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.activity_window_started_at
        when v_has_pending_knowledge then now()
        else null end,
      window_cutoff_at = case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.window_cutoff_at else null end,
      updated_at = now()
  returning * into v_job;

  return v_job;
end;
$$;

revoke execute on function public.request_progression_cycle(date) from public, anon;
grant execute on function public.request_progression_cycle(date) to authenticated, service_role;
