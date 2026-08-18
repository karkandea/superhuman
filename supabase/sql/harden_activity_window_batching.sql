-- Activity-window orchestration for personal progression processing.
-- Debounce normal Vault activity, enforce a max wait, snapshot a stable processing cutoff,
-- preserve later updates for the next window, and pause external provider throttling with a circuit breaker.

alter table public.ai_inference_jobs drop constraint if exists ai_inference_jobs_status_check;
alter table public.ai_inference_jobs add constraint ai_inference_jobs_status_check
  check (status in ('queued','running','succeeded','failed','blocked_auth','paused_rate_limit'));

alter table public.ai_inference_jobs
  add column if not exists activity_window_started_at timestamptz,
  add column if not exists window_cutoff_at timestamptz;

alter table public.materiality_assessments
  add column if not exists knowledge_entry_ids uuid[] not null default '{}'::uuid[],
  add column if not exists batch_key text;

update public.materiality_assessments
set knowledge_entry_ids = array[knowledge_entry_id]
where cardinality(knowledge_entry_ids) = 0;

create unique index if not exists materiality_assessments_batch_key_uidx
  on public.materiality_assessments(user_id, batch_key)
  where batch_key is not null;

create index if not exists ai_inference_jobs_activity_window_idx
  on public.ai_inference_jobs(status, available_at, activity_window_started_at);

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

create or replace function public.enqueue_progression_on_knowledge_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_target_date date;
  v_job public.ai_inference_jobs;
  v_window_start timestamptz;
  v_inserted integer;
  v_debounce interval := interval '2 minutes';
  v_max_wait interval := interval '10 minutes';
begin
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

  select * into v_job from public.ai_inference_jobs
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
        error_code=null,error_message=null,completed_at=null,updated_at=now()
    where id=v_job.id;
    return new;
  end if;

  update public.ai_inference_jobs
  set status='queued',correlation_id=gen_random_uuid(),attempt_count=0,available_at=now()+v_debounce,
      lease_expires_at=null,worker_id=null,provider_id=null,provider_conversation_refs='[]'::jsonb,
      result_summary='{}'::jsonb,error_code=null,error_message=null,rerun_requested=false,
      started_at=null,completed_at=null,activity_window_started_at=now(),window_cutoff_at=null,updated_at=now()
  where id=v_job.id;
  return new;
end;
$$;
revoke execute on function public.enqueue_progression_on_knowledge_insert() from public, anon, authenticated, service_role;

drop trigger if exists knowledge_entries_enqueue_progression on public.knowledge_entries;
create trigger knowledge_entries_enqueue_progression after insert on public.knowledge_entries
for each row execute function public.enqueue_progression_on_knowledge_insert();

create or replace function public.claim_ai_inference_job(p_worker_id text,p_lease_seconds integer default 300)
returns setof public.ai_inference_jobs
language plpgsql
security definer
set search_path=''
as $$
declare v_job public.ai_inference_jobs;
begin
  if coalesce(btrim(p_worker_id),'')='' then raise exception 'worker id is required'; end if;
  if p_lease_seconds < 30 or p_lease_seconds > 1800 then raise exception 'lease must be between 30 and 1800 seconds'; end if;

  select * into v_job from public.ai_inference_jobs
  where status <> 'paused_rate_limit'
    and attempt_count < max_attempts
    and ((status='queued' and available_at<=now()) or (status='running' and lease_expires_at is not null and lease_expires_at<now()))
  order by available_at,created_at for update skip locked limit 1;
  if not found then return; end if;

  update public.ai_inference_jobs
  set status='running',
      attempt_count=case when v_job.error_code='provider_rate_limited' then attempt_count else attempt_count+1 end,
      worker_id=p_worker_id,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      started_at=coalesce(started_at,now()),
      window_cutoff_at=coalesce(window_cutoff_at,now()),
      activity_window_started_at=case when v_job.window_cutoff_at is null then null else activity_window_started_at end,
      error_code=null,error_message=null,updated_at=now()
  where id=v_job.id returning * into v_job;
  return next v_job;
  return;
end;
$$;
revoke execute on function public.claim_ai_inference_job(text,integer) from public, anon, authenticated;
grant execute on function public.claim_ai_inference_job(text,integer) to service_role;

create or replace function public.schedule_ai_inference_retry(
  p_job_id uuid,p_worker_id text,p_error_code text,p_error_message text,p_delay_seconds integer default 5,
  p_provider_id text default null,p_provider_conversation_refs jsonb default '[]'::jsonb)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.ai_inference_jobs;
  v_rate_limit_count integer := 0;
  v_delay_seconds integer;
begin
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs)<>'array' then
    raise exception 'provider conversation refs must be a JSON array';
  end if;
  select * into v_job from public.ai_inference_jobs
  where id=p_job_id and status='running' and worker_id=p_worker_id for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;

  if p_error_code='provider_rate_limited' then
    if coalesce(v_job.result_summary->>'provider_rate_limit_count','') ~ '^\d+$' then
      v_rate_limit_count := (v_job.result_summary->>'provider_rate_limit_count')::integer;
    end if;
    v_rate_limit_count := v_rate_limit_count + 1;

    if v_rate_limit_count >= 3 then
      update public.ai_inference_jobs
      set status='paused_rate_limit',lease_expires_at=null,worker_id=null,
          provider_id=coalesce(p_provider_id,provider_id),
          provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
          result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object('provider_rate_limit_count',v_rate_limit_count,'circuit_breaker','open'),
          error_code=p_error_code,error_message=left(coalesce(p_error_message,''),2000),completed_at=now(),updated_at=now()
      where id=p_job_id returning * into v_job;
      return v_job;
    end if;

    v_delay_seconds := case when v_rate_limit_count=1 then 900 else 1800 end;
    update public.ai_inference_jobs
    set status='queued',available_at=now()+make_interval(secs=>v_delay_seconds),lease_expires_at=null,worker_id=null,
        provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
        result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object('provider_rate_limit_count',v_rate_limit_count,'circuit_breaker','closed'),
        error_code=p_error_code,error_message=left(coalesce(p_error_message,''),2000),completed_at=null,updated_at=now()
    where id=p_job_id returning * into v_job;
    return v_job;
  end if;

  if v_job.attempt_count >= v_job.max_attempts then
    update public.ai_inference_jobs set status='failed',lease_expires_at=null,worker_id=null,
      provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
      error_code=p_error_code,error_message=left(coalesce(p_error_message,''),2000),completed_at=now(),updated_at=now()
    where id=p_job_id returning * into v_job;
  else
    update public.ai_inference_jobs set status='queued',available_at=now()+make_interval(secs=>greatest(1,least(p_delay_seconds,300))),
      lease_expires_at=null,worker_id=null,provider_id=coalesce(p_provider_id,provider_id),
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
declare
  v_job public.ai_inference_jobs;
  v_window_start timestamptz;
  v_next_available timestamptz;
begin
  if p_status not in ('succeeded','failed','blocked_auth') then raise exception 'Unsupported terminal inference status'; end if;
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs)<>'array' then raise exception 'provider conversation refs must be a JSON array'; end if;
  if p_result_summary is null or jsonb_typeof(p_result_summary)<>'object' then raise exception 'result summary must be a JSON object'; end if;

  select * into v_job from public.ai_inference_jobs where id=p_job_id and status='running' and worker_id=p_worker_id for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;

  if p_status='succeeded' and v_job.rerun_requested then
    v_window_start := coalesce(v_job.activity_window_started_at,now());
    v_next_available := least(now()+interval '2 minutes',v_window_start+interval '10 minutes');
    update public.ai_inference_jobs
    set status='queued',correlation_id=gen_random_uuid(),attempt_count=0,available_at=v_next_available,lease_expires_at=null,
        worker_id=null,rerun_requested=false,provider_id=coalesce(p_provider_id,provider_id),
        provider_conversation_refs='[]'::jsonb,result_summary=p_result_summary,
        error_code=null,error_message=null,started_at=null,completed_at=null,
        activity_window_started_at=v_window_start,window_cutoff_at=null,updated_at=now()
    where id=p_job_id returning * into v_job;
    return v_job;
  end if;

  update public.ai_inference_jobs
  set status=p_status,lease_expires_at=null,worker_id=null,rerun_requested=false,
      provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
      result_summary=p_result_summary,error_code=p_error_code,error_message=left(coalesce(p_error_message,''),2000),
      completed_at=now(),activity_window_started_at=null,window_cutoff_at=null,updated_at=now()
  where id=p_job_id returning * into v_job;
  return v_job;
end;
$$;
revoke execute on function public.complete_ai_inference_job(uuid,text,text,text,jsonb,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.complete_ai_inference_job(uuid,text,text,text,jsonb,jsonb,text,text) to service_role;

create or replace function public.persist_materiality_batch_assessment(
  p_user_id uuid,
  p_knowledge_entry_ids uuid[],
  p_batch_key text,
  p_target_date date,
  p_assessment jsonb,
  p_signal_ids uuid[] default '{}'::uuid[],
  p_active_quest_ids uuid[] default '{}'::uuid[],
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'materiality-batch.v1',
  p_generated_at timestamptz default now(),
  p_player_timezone text default 'UTC',
  p_local_datetime text default '',
  p_retrieval jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_existing public.materiality_assessments;
  v_snapshot_id uuid;
  v_assessment_id uuid;
  v_primary_knowledge_id uuid;
  v_is_material boolean;
  v_level text;
  v_confidence numeric;
  v_reason text;
  v_recommended_action text;
  v_urgency text;
  v_disposition text;
  v_affected uuid[] := '{}'::uuid[];
  v_sources uuid[] := '{}'::uuid[];
  v_expected integer;
  v_actual integer;
begin
  if p_user_id is null or p_target_date is null or coalesce(cardinality(p_knowledge_entry_ids),0)=0 then
    raise exception 'player, target date, and knowledge entries are required';
  end if;
  if coalesce(btrim(p_batch_key),'')='' then raise exception 'batch key is required'; end if;
  if p_assessment is null or jsonb_typeof(p_assessment)<>'object' then raise exception 'Materiality assessment must be an object'; end if;
  if p_retrieval is null or jsonb_typeof(p_retrieval)<>'object' then raise exception 'Retrieval metadata must be an object'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_batch_key,0));
  select * into v_existing from public.materiality_assessments where user_id=p_user_id and batch_key=p_batch_key;
  if found then
    update public.knowledge_entries set materiality_status='assessed',updated_at=now()
    where user_id=p_user_id and id=any(v_existing.knowledge_entry_ids);
    return to_jsonb(v_existing);
  end if;

  select count(*) into v_expected from (select distinct unnest(p_knowledge_entry_ids)) x;
  select count(*) into v_actual from public.knowledge_entries
  where user_id=p_user_id and id=any(p_knowledge_entry_ids) and processing_status='processed';
  if v_expected<>v_actual then raise exception 'Materiality batch contains missing, cross-player, or unprocessed knowledge'; end if;
  select id into v_primary_knowledge_id from unnest(p_knowledge_entry_ids) with ordinality x(id,n) order by n limit 1;

  v_is_material := coalesce((p_assessment->>'isMaterial')::boolean,false);
  v_level := p_assessment->>'level';
  v_confidence := (p_assessment->>'confidence')::numeric;
  v_reason := btrim(coalesce(p_assessment->>'reason',''));
  v_recommended_action := p_assessment->>'recommendedAction';
  v_urgency := p_assessment->>'urgency';
  if v_level not in ('low','medium','high','critical') then raise exception 'Invalid materiality level'; end if;
  if v_confidence<0 or v_confidence>1 then raise exception 'Invalid materiality confidence'; end if;
  if v_reason='' then raise exception 'Materiality reason is required'; end if;
  if v_recommended_action not in ('none','add','replace','defer','cancel','reprioritize') then raise exception 'Invalid materiality action'; end if;
  if v_urgency not in ('none','today','immediate') then raise exception 'Invalid materiality urgency'; end if;

  select coalesce(array_agg(value::uuid),'{}'::uuid[]) into v_affected from jsonb_array_elements_text(coalesce(p_assessment->'affectedQuestIds','[]'::jsonb));
  select coalesce(array_agg(value::uuid),'{}'::uuid[]) into v_sources from jsonb_array_elements_text(coalesce(p_assessment->'sourceSignalIds','[]'::jsonb));
  if exists(select 1 from unnest(v_affected) id where not(id=any(coalesce(p_active_quest_ids,'{}'::uuid[])))) then raise exception 'Materiality references quest outside active context'; end if;
  if exists(select 1 from unnest(v_sources) id where not(id=any(coalesce(p_signal_ids,'{}'::uuid[])))) then raise exception 'Materiality references signal outside retrieved context'; end if;

  select count(*) into v_expected from (select distinct unnest(coalesce(p_signal_ids,'{}'::uuid[]))) x;
  select count(*) into v_actual from public.player_signals where user_id=p_user_id and id=any(coalesce(p_signal_ids,'{}'::uuid[]));
  if v_expected<>v_actual then raise exception 'Materiality signal context contains missing or cross-player signals'; end if;
  select count(*) into v_expected from (select distinct unnest(coalesce(p_active_quest_ids,'{}'::uuid[]))) x;
  select count(*) into v_actual from public.daily_quests
  where user_id=p_user_id and quest_date=p_target_date and id=any(coalesce(p_active_quest_ids,'{}'::uuid[])) and status in ('pending','partial');
  if v_expected<>v_actual then raise exception 'Materiality quest context is stale or cross-player'; end if;

  if not v_is_material then
    if v_recommended_action<>'none' or v_urgency<>'none' then raise exception 'Non-material assessment must recommend no change'; end if;
    v_disposition := 'no_change';
  elsif v_confidence<0.65 or v_urgency='none' then v_disposition := 'no_change';
  elsif v_level in ('high','critical') and v_confidence>=0.85 and v_urgency in ('today','immediate') then v_disposition := 'auto_interrupt';
  else v_disposition := 'suggest';
  end if;

  insert into public.context_snapshots(user_id,context_date,purpose,summary,retrieval_metadata,generated_at)
  values(p_user_id,p_target_date,'materiality','Activity-window knowledge + relevant signals + active quests used for one materiality decision',
    p_retrieval||jsonb_build_object('provider_id',p_provider_id,'model_id',p_model_id,'request_id',p_request_id,'schema_version',p_version,'player_timezone',p_player_timezone,'local_datetime',p_local_datetime,'batch_key',p_batch_key),p_generated_at)
  returning id into v_snapshot_id;

  insert into public.context_snapshot_knowledge(user_id,snapshot_id,knowledge_entry_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,id,ordinality::smallint,'activity-window materiality trigger'
  from unnest(p_knowledge_entry_ids) with ordinality x(id,ordinality);
  insert into public.context_snapshot_signals(user_id,snapshot_id,signal_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,id,ordinality::smallint,'relevant player signal'
  from unnest(coalesce(p_signal_ids,'{}'::uuid[])) with ordinality x(id,ordinality);
  insert into public.context_snapshot_quests(user_id,snapshot_id,quest_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,id,ordinality::smallint,'active quest compared against activity window'
  from unnest(coalesce(p_active_quest_ids,'{}'::uuid[])) with ordinality x(id,ordinality);

  insert into public.materiality_assessments(
    user_id,knowledge_entry_id,knowledge_entry_ids,batch_key,target_date,context_snapshot_id,is_material,level,confidence,reason,
    affected_quest_ids,source_signal_ids,recommended_action,urgency,disposition,
    provider_id,model_id,model_request_id,assessment_version,player_timezone,local_datetime,created_at
  ) values (
    p_user_id,v_primary_knowledge_id,p_knowledge_entry_ids,p_batch_key,p_target_date,v_snapshot_id,v_is_material,v_level,v_confidence,v_reason,
    v_affected,v_sources,v_recommended_action,v_urgency,v_disposition,
    p_provider_id,p_model_id,p_request_id,p_version,p_player_timezone,p_local_datetime,p_generated_at
  ) returning id into v_assessment_id;

  update public.knowledge_entries set materiality_status='assessed',updated_at=now()
  where user_id=p_user_id and id=any(p_knowledge_entry_ids);

  return (select to_jsonb(a) from public.materiality_assessments a where a.id=v_assessment_id);
end;
$$;
revoke execute on function public.persist_materiality_batch_assessment(uuid,uuid[],text,date,jsonb,uuid[],uuid[],text,text,text,text,timestamptz,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.persist_materiality_batch_assessment(uuid,uuid[],text,date,jsonb,uuid[],uuid[],text,text,text,text,timestamptz,text,text,jsonb) to service_role;
