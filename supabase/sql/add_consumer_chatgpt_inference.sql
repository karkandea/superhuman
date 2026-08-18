-- Production AI inference queue + event trigger + daily scheduler.
-- Uses the consumer ChatGPT browser worker while keeping Supabase canonical.
-- New raw Player Knowledge re-queues the current progression cycle immediately.
-- Existing Daily Quests remain stable because the worker returns the persisted batch when one exists.

create table if not exists public.ai_inference_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  operation text not null default 'progression_cycle' check (operation = 'progression_cycle'),
  target_date date not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','blocked_auth')),
  correlation_id uuid not null default gen_random_uuid(),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  worker_id text,
  provider_id text,
  provider_conversation_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(provider_conversation_refs) = 'array'),
  result_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(result_summary) = 'object'),
  error_code text,
  error_message text,
  rerun_requested boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, operation, target_date)
);

alter table public.ai_inference_jobs add column if not exists rerun_requested boolean not null default false;
create index if not exists ai_inference_jobs_queue_idx on public.ai_inference_jobs(status, available_at, created_at);
create index if not exists ai_inference_jobs_user_date_idx on public.ai_inference_jobs(user_id, target_date desc, created_at desc);

alter table public.ai_inference_jobs enable row level security;
revoke all on table public.ai_inference_jobs from anon, authenticated;
grant select on table public.ai_inference_jobs to authenticated;
grant select, insert, update, delete on table public.ai_inference_jobs to service_role;

drop policy if exists ai_inference_jobs_select_own on public.ai_inference_jobs;
create policy ai_inference_jobs_select_own on public.ai_inference_jobs for select to authenticated
using ((select auth.uid()) = user_id);

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
  v_has_pending_knowledge boolean;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_target_date is null then raise exception 'target date is required'; end if;
  if not exists (select 1 from public.users where id = v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode = '42501';
  end if;

  select exists(select 1 from public.daily_quests where user_id=v_user_id and quest_date=p_target_date) into v_has_quests;
  select exists(select 1 from public.knowledge_entries where user_id=v_user_id and processing_status in ('pending','failed')) into v_has_pending_knowledge;

  insert into public.ai_inference_jobs(user_id,operation,target_date,status,completed_at)
  values (v_user_id,'progression_cycle',p_target_date,
          case when v_has_quests and not v_has_pending_knowledge then 'succeeded' else 'queued' end,
          case when v_has_quests and not v_has_pending_knowledge then now() else null end)
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
      updated_at = now()
  returning * into v_job;
  return v_job;
end;
$$;
revoke execute on function public.request_progression_cycle(date) from public, anon;
grant execute on function public.request_progression_cycle(date) to authenticated, service_role;

create or replace function public.claim_ai_inference_job(p_worker_id text, p_lease_seconds integer default 300)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.ai_inference_jobs;
begin
  if coalesce(btrim(p_worker_id),'')='' then raise exception 'worker id is required'; end if;
  if p_lease_seconds < 30 or p_lease_seconds > 1800 then raise exception 'lease must be between 30 and 1800 seconds'; end if;
  select * into v_job from public.ai_inference_jobs
  where attempt_count < max_attempts
    and ((status='queued' and available_at<=now()) or (status='running' and lease_expires_at is not null and lease_expires_at<now()))
  order by available_at, created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.ai_inference_jobs
  set status='running', attempt_count=attempt_count+1, worker_id=p_worker_id,
      lease_expires_at=now()+make_interval(secs=>p_lease_seconds), started_at=coalesce(started_at,now()),
      error_code=null,error_message=null,updated_at=now()
  where id=v_job.id returning * into v_job;
  return v_job;
end;
$$;
revoke execute on function public.claim_ai_inference_job(text,integer) from public, anon, authenticated;
grant execute on function public.claim_ai_inference_job(text,integer) to service_role;

create or replace function public.heartbeat_ai_inference_job(p_job_id uuid,p_worker_id text,p_lease_seconds integer default 300)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare v_updated integer;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 1800 then raise exception 'lease must be between 30 and 1800 seconds'; end if;
  update public.ai_inference_jobs set lease_expires_at=now()+make_interval(secs=>p_lease_seconds),updated_at=now()
  where id=p_job_id and status='running' and worker_id=p_worker_id;
  get diagnostics v_updated=row_count;
  return v_updated=1;
end;
$$;
revoke execute on function public.heartbeat_ai_inference_job(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.heartbeat_ai_inference_job(uuid,text,integer) to service_role;

create or replace function public.schedule_ai_inference_retry(
  p_job_id uuid,p_worker_id text,p_error_code text,p_error_message text,p_delay_seconds integer default 5,
  p_provider_id text default null,p_provider_conversation_refs jsonb default '[]'::jsonb)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path=''
as $$
declare v_job public.ai_inference_jobs;
begin
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs)<>'array' then raise exception 'provider conversation refs must be a JSON array'; end if;
  select * into v_job from public.ai_inference_jobs where id=p_job_id and status='running' and worker_id=p_worker_id for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;
  if v_job.attempt_count >= v_job.max_attempts then
    update public.ai_inference_jobs set status='failed',lease_expires_at=null,worker_id=null,rerun_requested=false,
      provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
      error_code=p_error_code,error_message=left(coalesce(p_error_message,''),2000),completed_at=now(),updated_at=now()
    where id=p_job_id returning * into v_job;
  else
    update public.ai_inference_jobs set status='queued',available_at=now()+make_interval(secs=>greatest(1,least(p_delay_seconds,300))),
      lease_expires_at=null,worker_id=null,rerun_requested=false,provider_id=coalesce(p_provider_id,provider_id),
      provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,error_code=p_error_code,
      error_message=left(coalesce(p_error_message,''),2000),updated_at=now()
    where id=p_job_id returning * into v_job;
  end if;
  return v_job;
end;
$$;
revoke execute on function public.schedule_ai_inference_retry(uuid,text,text,text,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.schedule_ai_inference_retry(uuid,text,text,text,integer,text,jsonb) to service_role;

create or replace function public.complete_ai_inference_job(
  p_job_id uuid,p_worker_id text,p_status text,p_provider_id text default null,
  p_provider_conversation_refs jsonb default '[]'::jsonb,p_result_summary jsonb default '{}'::jsonb,
  p_error_code text default null,p_error_message text default null)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path=''
as $$
declare v_job public.ai_inference_jobs;
begin
  if p_status not in ('succeeded','failed','blocked_auth') then raise exception 'Unsupported terminal inference status'; end if;
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs)<>'array' then raise exception 'provider conversation refs must be a JSON array'; end if;
  if p_result_summary is null or jsonb_typeof(p_result_summary)<>'object' then raise exception 'result summary must be a JSON object'; end if;
  select * into v_job from public.ai_inference_jobs where id=p_job_id and status='running' and worker_id=p_worker_id for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;
  if p_status='succeeded' and v_job.rerun_requested then
    update public.ai_inference_jobs
    set status='queued',correlation_id=gen_random_uuid(),attempt_count=0,available_at=now(),lease_expires_at=null,
        worker_id=null,rerun_requested=false,provider_id=coalesce(p_provider_id,provider_id),
        provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,result_summary=p_result_summary,
        error_code=null,error_message=null,started_at=null,completed_at=null,updated_at=now()
    where id=p_job_id returning * into v_job;
    return v_job;
  end if;
  update public.ai_inference_jobs
  set status=p_status,lease_expires_at=null,worker_id=null,rerun_requested=false,
      provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
      result_summary=p_result_summary,error_code=p_error_code,error_message=left(coalesce(p_error_message,''),2000),
      completed_at=now(),updated_at=now()
  where id=p_job_id returning * into v_job;
  return v_job;
end;
$$;
revoke execute on function public.complete_ai_inference_job(uuid,text,text,text,jsonb,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.complete_ai_inference_job(uuid,text,text,text,jsonb,jsonb,text,text) to service_role;

create or replace function public.set_daily_quest_completion(p_quest_id uuid,p_completed boolean)
returns void
language plpgsql
security invoker
set search_path=''
as $$
declare v_user_id uuid:=auth.uid(); v_updated integer;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  update public.daily_quests set status=case when p_completed then 'completed' else 'pending' end,
    completed_at=case when p_completed then now() else null end
  where id=p_quest_id and user_id=v_user_id;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then raise exception 'Quest not found for authenticated player' using errcode='42501'; end if;
  if p_completed then
    insert into public.quest_results(user_id,quest_id,outcome,recorded_at) values(v_user_id,p_quest_id,'completed',now())
    on conflict(quest_id) do update set outcome='completed',recorded_at=now();
  else
    delete from public.quest_results where user_id=v_user_id and quest_id=p_quest_id;
  end if;
end;
$$;
grant delete on table public.quest_results to authenticated;
drop policy if exists quest_results_delete_own on public.quest_results;
create policy quest_results_delete_own on public.quest_results for delete to authenticated using ((select auth.uid())=user_id);
revoke execute on function public.set_daily_quest_completion(uuid,boolean) from public, anon;
grant execute on function public.set_daily_quest_completion(uuid,boolean) to authenticated, service_role;

create or replace function public.enqueue_progression_on_knowledge_insert()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare v_timezone text; v_target_date date;
begin
  select timezone into v_timezone from public.users where id=new.user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone:='UTC'; end if;
  v_target_date := (now() at time zone v_timezone)::date;
  insert into public.ai_inference_jobs(user_id,operation,target_date,status)
  values(new.user_id,'progression_cycle',v_target_date,'queued')
  on conflict(user_id,operation,target_date) do update
  set rerun_requested=case when public.ai_inference_jobs.status='running' then true else false end,
      status=case when public.ai_inference_jobs.status='running' then 'running' else 'queued' end,
      correlation_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.correlation_id else gen_random_uuid() end,
      attempt_count=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.attempt_count else 0 end,
      available_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.available_at else now() end,
      lease_expires_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.lease_expires_at else null end,
      worker_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.worker_id else null end,
      error_code=null,error_message=null,
      completed_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.completed_at else null end,
      updated_at=now();
  return new;
end;
$$;
revoke execute on function public.enqueue_progression_on_knowledge_insert() from public, anon, authenticated, service_role;
drop trigger if exists knowledge_entries_enqueue_progression on public.knowledge_entries;
create trigger knowledge_entries_enqueue_progression after insert on public.knowledge_entries
for each row execute function public.enqueue_progression_on_knowledge_insert();

create or replace function public.enqueue_daily_progression_cycles()
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare v_count integer;
begin
  with player_clock as (
    select u.id,case when exists(select 1 from pg_catalog.pg_timezone_names z where z.name=u.timezone) then u.timezone else 'UTC' end as tz
    from public.users u
  ), due as (
    select id,(now() at time zone tz)::date as local_date,(now() at time zone tz)::time as local_time from player_clock
  ), inserted as (
    insert into public.ai_inference_jobs(user_id,operation,target_date,status)
    select id,'progression_cycle',local_date,'queued' from due where local_time>=time '04:00'
    on conflict(user_id,operation,target_date) do nothing returning 1
  ) select count(*) into v_count from inserted;
  return v_count;
end;
$$;
revoke execute on function public.enqueue_daily_progression_cycles() from public, anon, authenticated, service_role;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
select cron.schedule('superhuman-daily-progression-enqueue','*/15 * * * *',$cron$select public.enqueue_daily_progression_cycles();$cron$);
select public.enqueue_daily_progression_cycles();
