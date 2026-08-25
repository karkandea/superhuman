-- Service-role-only escape hatch for validating a worker fix against one terminal progression job.
-- This is deliberately separate from player-facing start/status RPCs and preserves all recovery counters.

create or replace function public.operator_requeue_progression_job(
  p_job_id uuid,
  p_reason text default 'post_fix_validation'
)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.ai_inference_jobs;
  v_operator_requeue_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_job_id is null then
    raise exception 'job id is required';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'operator requeue reason is required';
  end if;

  select * into v_job
  from public.ai_inference_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception 'AI inference job not found';
  end if;
  if v_job.operation <> 'progression_cycle' then
    raise exception 'Only progression_cycle jobs can be operator-requeued';
  end if;
  if v_job.status <> 'failed' then
    raise exception 'Only failed jobs can be operator-requeued';
  end if;
  if exists(
    select 1
    from public.quest_batches b
    where b.user_id = v_job.user_id
      and b.quest_date = v_job.target_date
      and b.status = 'generated'
  ) then
    raise exception 'Generated quest batch already exists';
  end if;

  if coalesce(v_job.result_summary->>'operatorRequeueCount', '') ~ '^\d+$' then
    v_operator_requeue_count := (v_job.result_summary->>'operatorRequeueCount')::integer;
  end if;
  if v_operator_requeue_count >= 1 then
    raise exception 'Operator requeue budget already used';
  end if;

  update public.ai_inference_jobs
  set status = 'queued',
      correlation_id = gen_random_uuid(),
      attempt_count = 0,
      available_at = now(),
      lease_expires_at = null,
      worker_id = null,
      rerun_requested = false,
      error_code = null,
      error_message = null,
      started_at = null,
      completed_at = null,
      activity_window_started_at = now(),
      window_cutoff_at = null,
      result_summary = coalesce(result_summary, '{}'::jsonb) || jsonb_build_object(
        'operatorRequeueCount', v_operator_requeue_count + 1,
        'operatorRequeueReason', left(btrim(p_reason), 200),
        'operatorRequeuedAt', now()
      ),
      updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$function$;

revoke all on function public.operator_requeue_progression_job(uuid,text)
  from public, anon, authenticated;
grant execute on function public.operator_requeue_progression_job(uuid,text)
  to service_role;
