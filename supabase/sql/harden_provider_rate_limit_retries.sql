-- Preserve normal inference retry budget when the consumer ChatGPT session is externally rate-limited.
-- Provider throttling gets its own bounded counter and progressive backoff.

create or replace function public.claim_ai_inference_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.ai_inference_jobs;
begin
  if coalesce(btrim(p_worker_id), '') = '' then
    raise exception 'worker id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 1800 then
    raise exception 'lease must be between 30 and 1800 seconds';
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where attempt_count < max_attempts
    and (
      (status = 'queued' and available_at <= now())
      or (status = 'running' and lease_expires_at is not null and lease_expires_at < now())
    )
  order by available_at, created_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.ai_inference_jobs
  set status = 'running',
      -- A provider throttle is not an inference/model failure. Preserve the
      -- normal retry budget while the separate throttle counter is bounded
      -- by schedule_ai_inference_retry().
      attempt_count = case
        when v_job.error_code = 'provider_rate_limited' then attempt_count
        else attempt_count + 1
      end,
      worker_id = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()),
      error_code = null,
      error_message = null,
      updated_at = now()
  where id = v_job.id
  returning * into v_job;

  return next v_job;
  return;
end;
$$;

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
set search_path = ''
as $$
declare
  v_job public.ai_inference_jobs;
  v_rate_limit_count integer := 0;
  v_delay_seconds integer;
begin
  if p_provider_conversation_refs is null or jsonb_typeof(p_provider_conversation_refs) <> 'array' then
    raise exception 'provider conversation refs must be a JSON array';
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where id = p_job_id and status = 'running' and worker_id = p_worker_id
  for update;

  if not found then
    raise exception 'Inference job is not owned by this worker';
  end if;

  if p_error_code = 'provider_rate_limited' then
    if coalesce(v_job.result_summary->>'provider_rate_limit_count', '') ~ '^\d+$' then
      v_rate_limit_count := (v_job.result_summary->>'provider_rate_limit_count')::integer;
    end if;
    v_rate_limit_count := v_rate_limit_count + 1;

    -- Bound external-throttle retries independently from inference attempts.
    if v_rate_limit_count >= 12 then
      update public.ai_inference_jobs
      set status = 'failed',
          lease_expires_at = null,
          worker_id = null,
          rerun_requested = false,
          provider_id = coalesce(p_provider_id, provider_id),
          provider_conversation_refs = provider_conversation_refs || p_provider_conversation_refs,
          result_summary = coalesce(result_summary, '{}'::jsonb)
            || jsonb_build_object('provider_rate_limit_count', v_rate_limit_count),
          error_code = p_error_code,
          error_message = left(coalesce(p_error_message, ''), 2000),
          completed_at = now(),
          updated_at = now()
      where id = p_job_id
      returning * into v_job;

      return v_job;
    end if;

    v_delay_seconds := case
      when v_rate_limit_count = 1 then 60
      when v_rate_limit_count = 2 then 120
      when v_rate_limit_count = 3 then 240
      else 300
    end;

    update public.ai_inference_jobs
    set status = 'queued',
        available_at = now() + make_interval(secs => v_delay_seconds),
        lease_expires_at = null,
        worker_id = null,
        rerun_requested = false,
        provider_id = coalesce(p_provider_id, provider_id),
        provider_conversation_refs = provider_conversation_refs || p_provider_conversation_refs,
        result_summary = coalesce(result_summary, '{}'::jsonb)
          || jsonb_build_object('provider_rate_limit_count', v_rate_limit_count),
        error_code = p_error_code,
        error_message = left(coalesce(p_error_message, ''), 2000),
        completed_at = null,
        updated_at = now()
    where id = p_job_id
    returning * into v_job;

    return v_job;
  end if;

  if v_job.attempt_count >= v_job.max_attempts then
    update public.ai_inference_jobs
    set status = 'failed',
        lease_expires_at = null,
        worker_id = null,
        rerun_requested = false,
        provider_id = coalesce(p_provider_id, provider_id),
        provider_conversation_refs = provider_conversation_refs || p_provider_conversation_refs,
        error_code = p_error_code,
        error_message = left(coalesce(p_error_message, ''), 2000),
        completed_at = now(),
        updated_at = now()
    where id = p_job_id
    returning * into v_job;
  else
    update public.ai_inference_jobs
    set status = 'queued',
        available_at = now() + make_interval(secs => greatest(1, least(p_delay_seconds, 300))),
        lease_expires_at = null,
        worker_id = null,
        rerun_requested = false,
        provider_id = coalesce(p_provider_id, provider_id),
        provider_conversation_refs = provider_conversation_refs || p_provider_conversation_refs,
        error_code = p_error_code,
        error_message = left(coalesce(p_error_message, ''), 2000),
        updated_at = now()
    where id = p_job_id
    returning * into v_job;
  end if;

  return v_job;
end;
$$;

revoke all on function public.claim_ai_inference_job(text, integer) from public, anon, authenticated;
revoke all on function public.schedule_ai_inference_retry(uuid, text, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_ai_inference_job(text, integer) to service_role;
grant execute on function public.schedule_ai_inference_retry(uuid, text, text, text, integer, text, jsonb) to service_role;
