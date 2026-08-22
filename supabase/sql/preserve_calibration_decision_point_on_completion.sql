-- Preserve the initialization calibration marker when the worker completes a job.
-- Without this, complete_ai_inference_job(..., p_result_summary := '{}') erases
-- decisionPoint=initialization_calibration before the telemetry trigger can finalize it.

create or replace function public.complete_ai_inference_job(
  p_job_id uuid,p_worker_id text,p_status text,p_provider_id text default null,
  p_provider_conversation_refs jsonb default '[]'::jsonb,p_result_summary jsonb default '{}'::jsonb,
  p_error_code text default null,p_error_message text default null)
returns public.ai_inference_jobs language plpgsql security definer set search_path=''
as $$
declare
  v_job public.ai_inference_jobs;
  v_window_start timestamptz;
  v_next_available timestamptz;
  v_safe_code text:=public.safe_ai_failure_code(p_error_code,p_error_message);
  v_safe_message text:=public.safe_ai_failure_message(p_error_code,p_error_message);
  v_request_id text:=public.extract_ai_request_id(p_error_message);
  v_summary jsonb;
begin
  if p_status not in ('succeeded','failed','blocked_auth') then raise exception 'Unsupported terminal inference status'; end if;
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs)<>'array' then raise exception 'provider conversation refs must be a JSON array'; end if;
  if p_result_summary is null or jsonb_typeof(p_result_summary)<>'object' then raise exception 'result summary must be a JSON object'; end if;

  select * into v_job from public.ai_inference_jobs
  where id=p_job_id and status='running' and worker_id=p_worker_id for update;
  if not found then raise exception 'Inference job is not owned by this worker'; end if;

  v_summary:=coalesce(v_job.result_summary,'{}'::jsonb)||p_result_summary;

  if coalesce(v_job.result_summary->>'decisionPoint','')='initialization_calibration' and v_request_id is not null then
    update public.player_initialization_calibration_attempts set request_id=v_request_id
    where job_id=p_job_id and attempt_number=v_job.attempt_count;
  end if;

  if p_status='succeeded' and v_job.rerun_requested then
    v_window_start:=coalesce(v_job.activity_window_started_at,now());
    v_next_available:=least(now()+interval '2 minutes',v_window_start+interval '10 minutes');
    update public.ai_inference_jobs
    set status='queued',correlation_id=gen_random_uuid(),attempt_count=0,available_at=v_next_available,lease_expires_at=null,
        worker_id=null,rerun_requested=false,provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs='[]'::jsonb,
        result_summary=v_summary,error_code=null,error_message=null,started_at=null,completed_at=null,
        activity_window_started_at=v_window_start,window_cutoff_at=null,updated_at=now()
    where id=p_job_id returning * into v_job;
    return v_job;
  end if;

  update public.ai_inference_jobs
  set status=p_status,lease_expires_at=null,worker_id=null,rerun_requested=false,
      provider_id=coalesce(p_provider_id,provider_id),provider_conversation_refs=provider_conversation_refs||p_provider_conversation_refs,
      result_summary=v_summary,
      error_code=case when p_status='succeeded' then null else v_safe_code end,
      error_message=case when p_status='succeeded' then '' else v_safe_message end,
      completed_at=now(),activity_window_started_at=null,window_cutoff_at=null,updated_at=now()
  where id=p_job_id returning * into v_job;
  return v_job;
end;
$$;
