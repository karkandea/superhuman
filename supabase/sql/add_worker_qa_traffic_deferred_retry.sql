begin;

alter table public.worker_qa_iterations
  add column if not exists traffic_defer_count integer not null default 0 check (traffic_defer_count >= 0);

create or replace function public.schedule_worker_qa_traffic_deferred(
  p_iteration_id uuid,
  p_worker_id text,
  p_delay_seconds integer default 30,
  p_reason text default null
)
returns text
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_run_id uuid;
begin
  if p_delay_seconds < 5 or p_delay_seconds > 900 then
    raise exception 'QA traffic defer delay must be between 5 and 900 seconds';
  end if;

  select run_id into v_run_id
  from public.worker_qa_iterations
  where id=p_iteration_id
    and status='running'
    and worker_id=p_worker_id
  for update;

  if v_run_id is null then
    raise exception 'QA iteration is not owned by this worker';
  end if;

  if exists(select 1 from public.worker_qa_runs where id=v_run_id and status='cancelled') then
    update public.worker_qa_iterations
    set status='cancelled',
        traffic_defer_count=traffic_defer_count+1,
        lease_expires_at=null,
        completed_at=now(),
        updated_at=now()
    where id=p_iteration_id;
    return 'cancelled';
  end if;

  update public.worker_qa_iterations
  set status='queued',
      traffic_defer_count=traffic_defer_count+1,
      available_at=now()+make_interval(secs=>p_delay_seconds),
      lease_expires_at=null,
      worker_id=null,
      error_code='traffic_deferred',
      error_message=nullif(left(regexp_replace(coalesce(p_reason,''),'[\r\n\t]+',' ','g'),500),''),
      completed_at=null,
      updated_at=now()
  where id=p_iteration_id;

  return 'queued';
end;
$function$;

revoke all on function public.schedule_worker_qa_traffic_deferred(uuid,text,integer,text) from public, anon, authenticated;
grant execute on function public.schedule_worker_qa_traffic_deferred(uuid,text,integer,text) to service_role;

commit;
