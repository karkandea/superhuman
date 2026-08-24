begin;

create or replace function public.progression_session_on_run_step()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_session_id uuid;
  v_state text;
begin
  if new.status <> 'running' then return new; end if;

  select id into v_session_id
  from public.progression_sessions
  where user_id=new.user_id and status='active'
  order by opened_at desc
  limit 1;

  if v_session_id is null then return new; end if;

  v_state := case
    when new.step in ('understanding','progression_map','progression_map_after_learning') then 'understanding'
    when new.step in ('progression_target','quest_generation','quest_repair') then 'deciding'
    else null
  end;

  if v_state is null then return new; end if;

  update public.progression_sessions
  set state=v_state,
      target_date=coalesce(target_date,new.target_date),
      current_job_id=new.job_id,
      state_metadata=coalesce(state_metadata,'{}'::jsonb) || jsonb_build_object(
        'workerStep',new.step,
        'jobId',new.job_id,
        'targetDate',new.target_date
      ),
      updated_at=now()
  where id=v_session_id;

  return new;
end;
$function$;

revoke all on function public.progression_session_on_run_step() from public,anon,authenticated,service_role;

drop trigger if exists progression_run_steps_progression_session_state on public.progression_run_steps;
create trigger progression_run_steps_progression_session_state
  after insert or update of status,step on public.progression_run_steps
  for each row execute function public.progression_session_on_run_step();

commit;
