-- Restore automatic progression processing for ordinary Life Vault updates.
-- Initialization answers remain explicitly controlled by the calibration flow so one onboarding answer
-- does not spawn an independent progression cycle.

create or replace function public.enqueue_progression_on_knowledge_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_timezone text;
  v_target_date date;
  v_readiness text;
  v_job public.ai_inference_jobs;
  v_window_start timestamptz;
  v_inserted integer;
  v_debounce interval := interval '2 minutes';
  v_max_wait interval := interval '10 minutes';
begin
  -- Initialization evidence is intentionally batched by request_initialization_calibration().
  if coalesce(new.content_metadata->>'system','') = 'player_initialization' then
    return new;
  end if;

  if new.processing_status not in ('pending','failed') then
    return new;
  end if;

  select readiness into v_readiness
  from public.player_initializations
  where user_id = new.user_id;

  -- Do not run the normal progression loop before onboarding is READY.
  if coalesce(v_readiness,'ask') <> 'ready' then
    return new;
  end if;

  select timezone into v_timezone from public.users where id=new.user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_target_date := (now() at time zone v_timezone)::date;

  insert into public.ai_inference_jobs(
    user_id,operation,target_date,status,available_at,activity_window_started_at
  ) values (
    new.user_id,'progression_cycle',v_target_date,'queued',now()+v_debounce,now()
  ) on conflict(user_id,operation,target_date) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then return new; end if;

  select * into v_job
  from public.ai_inference_jobs
  where user_id=new.user_id and operation='progression_cycle' and target_date=v_target_date
  for update;

  if v_job.status = 'running' then
    update public.ai_inference_jobs
    set rerun_requested=true,
        activity_window_started_at=coalesce(activity_window_started_at,now()),
        updated_at=now()
    where id=v_job.id;
    return new;
  end if;

  -- Preserve provider cooldown/circuit-breaker state. New evidence waits behind the existing pause.
  if v_job.status = 'paused_rate_limit' then
    update public.ai_inference_jobs
    set rerun_requested=true,
        activity_window_started_at=coalesce(activity_window_started_at,now()),
        updated_at=now()
    where id=v_job.id;
    return new;
  end if;

  if v_job.status='queued' and v_job.error_code='provider_rate_limited' then
    update public.ai_inference_jobs
    set rerun_requested=true,
        activity_window_started_at=coalesce(activity_window_started_at,now()),
        updated_at=now()
    where id=v_job.id;
    return new;
  end if;

  if v_job.status='queued' then
    v_window_start := coalesce(v_job.activity_window_started_at,now());
    update public.ai_inference_jobs
    set available_at=least(now()+v_debounce,v_window_start+v_max_wait),
        activity_window_started_at=v_window_start,
        error_code=null,
        error_message=null,
        completed_at=null,
        updated_at=now()
    where id=v_job.id;
    return new;
  end if;

  update public.ai_inference_jobs
  set status='queued',
      correlation_id=gen_random_uuid(),
      attempt_count=0,
      available_at=now()+v_debounce,
      lease_expires_at=null,
      worker_id=null,
      provider_id=null,
      provider_conversation_refs='[]'::jsonb,
      result_summary='{}'::jsonb,
      error_code=null,
      error_message=null,
      rerun_requested=false,
      started_at=null,
      completed_at=null,
      activity_window_started_at=now(),
      window_cutoff_at=null,
      updated_at=now()
  where id=v_job.id;
  return new;
end;
$function$;

revoke all on function public.enqueue_progression_on_knowledge_insert() from public, anon, authenticated, service_role;

drop trigger if exists knowledge_entries_enqueue_progression on public.knowledge_entries;
create trigger knowledge_entries_enqueue_progression
  after insert on public.knowledge_entries
  for each row execute function public.enqueue_progression_on_knowledge_insert();