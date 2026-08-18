-- Make the worker claim RPC return an empty result set when no job is claimable.
-- PostgREST can otherwise serialize a NULL composite return as a row-shaped
-- object with NULL fields, which the browser worker may mistake for a real job.

drop function if exists public.claim_ai_inference_job(text, integer);

create function public.claim_ai_inference_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
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
      or (
        status = 'running'
        and lease_expires_at is not null
        and lease_expires_at < now()
      )
    )
  order by available_at, created_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.ai_inference_jobs
  set status = 'running',
      attempt_count = attempt_count + 1,
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
$function$;

revoke all on function public.claim_ai_inference_job(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_ai_inference_job(text, integer)
  to service_role;
