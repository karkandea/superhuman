-- Prevent deterministic model-contract failures from turning one user action into repeated provider calls.
-- Transport/rate-limit failures keep their existing retry semantics.

create or replace function public.schedule_ai_inference_retry(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_delay_seconds integer default 5,
  p_provider_id text default null,
  p_provider_conversation_refs jsonb default '[]'::jsonb
)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_rate_limit_count integer := 0;
  v_delay_seconds integer;
  v_safe_code text := public.safe_ai_failure_code(p_error_code,p_error_message);
  v_safe_message text := public.safe_ai_failure_message(p_error_code,p_error_message);
  v_request_id text := public.extract_ai_request_id(p_error_message);
begin
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs) <> 'array' then
    raise exception 'provider conversation refs must be a JSON array';
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where id = p_job_id and status = 'running' and worker_id = p_worker_id
  for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;

  if coalesce(v_job.result_summary->>'decisionPoint','') = 'initialization_calibration' and v_request_id is not null then
    update public.player_initialization_calibration_attempts
    set request_id = v_request_id
    where job_id = p_job_id and attempt_number = v_job.attempt_count;
  end if;

  -- A structurally invalid model response is deterministic for the exact request.
  -- Do not automatically send the same reasoning request two more times.
  if p_error_code = 'model_output_invalid' then
    update public.ai_inference_jobs
    set status = 'failed',
        lease_expires_at = null,
        worker_id = null,
        provider_id = coalesce(p_provider_id, provider_id),
        provider_conversation_refs = provider_conversation_refs || p_provider_conversation_refs,
        error_code = v_safe_code,
        error_message = v_safe_message,
        completed_at = now(),
        updated_at = now()
    where id = p_job_id
    returning * into v_job;
    return v_job;
  end if;

  if p_error_code = 'provider_rate_limited' then
    if coalesce(v_job.result_summary->>'provider_rate_limit_count','') ~ '^\d+$' then
      v_rate_limit_count := (v_job.result_summary->>'provider_rate_limit_count')::integer;
    end if;
    v_rate_limit_count := v_rate_limit_count + 1;
    if v_rate_limit_count >= 3 then
      update public.ai_inference_jobs
      set status='paused_rate_limit',lease_expires_at=null,worker_id=null,
          provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
          result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object('provider_rate_limit_count',v_rate_limit_count,'circuit_breaker','open'),
          error_code=v_safe_code,error_message=v_safe_message,completed_at=now(),updated_at=now()
      where id=p_job_id returning * into v_job;
      return v_job;
    end if;
    v_delay_seconds := case when v_rate_limit_count=1 then 900 else 1800 end;
    update public.ai_inference_jobs
    set status='queued',available_at=now()+make_interval(secs=>v_delay_seconds),lease_expires_at=null,worker_id=null,
        provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
        result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object('provider_rate_limit_count',v_rate_limit_count,'circuit_breaker','closed'),
        error_code=v_safe_code,error_message=v_safe_message,completed_at=null,updated_at=now()
    where id=p_job_id returning * into v_job;
    return v_job;
  end if;

  if v_job.attempt_count >= v_job.max_attempts then
    update public.ai_inference_jobs
    set status='failed',lease_expires_at=null,worker_id=null,
        provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
        error_code=v_safe_code,error_message=v_safe_message,completed_at=now(),updated_at=now()
    where id=p_job_id returning * into v_job;
  else
    update public.ai_inference_jobs
    set status='queued',available_at=now()+make_interval(secs=>greatest(1,least(p_delay_seconds,300))),
        lease_expires_at=null,worker_id=null,provider_id=coalesce(p_provider_id,provider_id),
        provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,error_code=v_safe_code,error_message=v_safe_message,updated_at=now()
    where id=p_job_id returning * into v_job;
  end if;
  return v_job;
end;
$function$;

create or replace function public.request_progression_cycle(p_target_date date)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_job public.ai_inference_jobs;
  v_existing public.ai_inference_jobs;
  v_has_plan boolean;
  v_has_daily_context boolean;
  v_has_pending_raw boolean;
  v_has_pending_materiality boolean;
  v_has_unresolved_interrupt boolean;
  v_has_pending_learning boolean;
  v_has_pending_progression boolean;
  v_readiness text;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_target_date is null then raise exception 'target date is required'; end if;
  if not exists(select 1 from public.users where id=v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode='42501';
  end if;

  select readiness into v_readiness from public.player_initializations where user_id=v_user_id;
  if coalesce(v_readiness,'ask') <> 'ready' then
    raise exception 'Player Initialization is not READY; Daily Quest decision is blocked';
  end if;

  select exists(select 1 from public.quest_batches where user_id=v_user_id and quest_date=p_target_date and status='generated') into v_has_plan;
  select exists(select 1 from public.daily_contexts where user_id=v_user_id and context_date=p_target_date) into v_has_daily_context;
  if not v_has_plan and not v_has_daily_context then
    raise exception 'Daily Context check-in required before first Daily Quest generation';
  end if;

  select * into v_existing
  from public.ai_inference_jobs
  where user_id=v_user_id and operation='progression_cycle' and target_date=p_target_date;

  -- User-facing RETRY must never reopen a deterministic contract failure.
  -- Recovery after a code/contract fix is an explicit operator action, not repeated user clicks.
  if found and v_existing.status='failed' and v_existing.error_code='model_output_invalid' then
    return v_existing;
  end if;

  update public.player_initializations
  set strategic_activation_pending=false,updated_at=now()
  where user_id=v_user_id and readiness='ready' and strategic_activation_pending=true;

  select exists(select 1 from public.knowledge_entries where user_id=v_user_id and processing_status in ('pending','failed')) into v_has_pending_raw;
  select exists(select 1 from public.knowledge_entries where user_id=v_user_id and processing_status='processed' and materiality_status in ('pending','failed')) into v_has_pending_materiality;
  select exists(
    select 1 from public.materiality_assessments a
    where a.user_id=v_user_id and a.target_date=p_target_date and a.disposition in ('suggest','auto_interrupt')
      and not exists(select 1 from public.quest_interrupts i where i.assessment_id=a.id)
  ) into v_has_unresolved_interrupt;
  select exists(
    select 1
    from public.daily_quests q
    left join public.quest_results r on r.quest_id=q.id and r.user_id=q.user_id
    left join public.quest_response_events e on e.quest_id=q.id and e.user_id=q.user_id
    where q.user_id=v_user_id
      and (
        (r.id is not null and (e.id is null or e.outcome<>r.outcome or e.reviewed_at is null))
        or (q.quest_date < p_target_date and q.status='pending' and (e.id is null or e.reviewed_at is null))
      )
  ) into v_has_pending_learning;

  v_has_pending_progression := v_has_pending_raw or v_has_pending_materiality or v_has_unresolved_interrupt or v_has_pending_learning;

  insert into public.ai_inference_jobs(user_id,operation,target_date,status,completed_at,activity_window_started_at,window_cutoff_at)
  values(
    v_user_id,'progression_cycle',p_target_date,
    case when v_has_plan and not v_has_pending_progression then 'succeeded' else 'queued' end,
    case when v_has_plan and not v_has_pending_progression then now() else null end,
    case when v_has_pending_progression then now() else null end,
    null
  )
  on conflict(user_id,operation,target_date) do update
  set status=case when public.ai_inference_jobs.status='running' then 'running' when v_has_plan and not v_has_pending_progression then 'succeeded' else 'queued' end,
      rerun_requested=case when public.ai_inference_jobs.status='running' and (v_has_pending_progression or (not v_has_plan and v_has_daily_context)) then true else false end,
      correlation_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.correlation_id else gen_random_uuid() end,
      attempt_count=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.attempt_count else 0 end,
      available_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.available_at else now() end,
      lease_expires_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.lease_expires_at else null end,
      worker_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.worker_id else null end,
      provider_id=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_id else null end,
      provider_conversation_refs=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.provider_conversation_refs else '[]'::jsonb end,
      result_summary=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.result_summary else '{}'::jsonb end,
      error_code=null,error_message=null,
      started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.started_at else null end,
      completed_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.completed_at when v_has_plan and not v_has_pending_progression then now() else null end,
      activity_window_started_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.activity_window_started_at when v_has_pending_progression then now() else null end,
      window_cutoff_at=case when public.ai_inference_jobs.status='running' then public.ai_inference_jobs.window_cutoff_at else null end,
      updated_at=now()
  returning * into v_job;
  return v_job;
end;
$function$;
