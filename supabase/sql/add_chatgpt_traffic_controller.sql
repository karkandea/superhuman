begin;

create table if not exists public.chatgpt_traffic_state (
  singleton boolean primary key default true check (singleton = true),
  active_holder text,
  active_kind text check (active_kind is null or active_kind in ('production','qa')),
  lease_expires_at timestamptz,
  cooldown_until timestamptz,
  qa_cooldown_until timestamptz,
  qa_next_allowed_at timestamptz,
  last_success_at timestamptz,
  last_success_kind text check (last_success_kind is null or last_success_kind in ('production','qa')),
  last_rate_limit_at timestamptz,
  rate_limit_streak integer not null default 0 check (rate_limit_streak >= 0),
  updated_at timestamptz not null default now()
);

insert into public.chatgpt_traffic_state(singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.chatgpt_traffic_state enable row level security;
revoke all on table public.chatgpt_traffic_state from public, anon, authenticated;
grant select on table public.chatgpt_traffic_state to service_role;

create or replace function public.acquire_chatgpt_traffic_slot(
  p_client_kind text,
  p_holder_id text,
  p_lease_seconds integer default 600
)
returns table(
  granted boolean,
  reason text,
  retry_after_seconds integer,
  cooldown_until timestamptz,
  qa_cooldown_until timestamptz,
  qa_next_allowed_at timestamptz,
  rate_limit_streak integer
)
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_state public.chatgpt_traffic_state;
  v_retry integer := 0;
begin
  if p_client_kind not in ('production','qa') then
    raise exception 'Unsupported ChatGPT traffic client kind: %', coalesce(p_client_kind,'<null>');
  end if;
  if coalesce(btrim(p_holder_id),'') = '' then
    raise exception 'ChatGPT traffic holder id is required';
  end if;
  if p_lease_seconds < 60 or p_lease_seconds > 900 then
    raise exception 'ChatGPT traffic lease must be between 60 and 900 seconds';
  end if;

  select * into v_state
  from public.chatgpt_traffic_state
  where singleton=true
  for update;

  if v_state.active_holder is not null
     and v_state.lease_expires_at is not null
     and v_state.lease_expires_at <= now() then
    update public.chatgpt_traffic_state
    set active_holder=null,
        active_kind=null,
        lease_expires_at=null,
        updated_at=now()
    where singleton=true;
    select * into v_state from public.chatgpt_traffic_state where singleton=true;
  end if;

  if v_state.cooldown_until is not null and v_state.cooldown_until > now() then
    v_retry := greatest(1, ceil(extract(epoch from (v_state.cooldown_until-now())))::integer);
    return query select false, 'global_cooldown', v_retry, v_state.cooldown_until, v_state.qa_cooldown_until, v_state.qa_next_allowed_at, v_state.rate_limit_streak;
    return;
  end if;

  if p_client_kind='qa' then
    if exists (
      select 1 from public.ai_inference_jobs j
      where j.status='running'
         or (j.status='queued' and j.available_at <= now() and j.attempt_count < j.max_attempts)
    ) then
      return query select false, 'production_priority', 5, v_state.cooldown_until, v_state.qa_cooldown_until, v_state.qa_next_allowed_at, v_state.rate_limit_streak;
      return;
    end if;

    if v_state.qa_cooldown_until is not null and v_state.qa_cooldown_until > now() then
      v_retry := greatest(1, ceil(extract(epoch from (v_state.qa_cooldown_until-now())))::integer);
      return query select false, 'qa_cooldown', v_retry, v_state.cooldown_until, v_state.qa_cooldown_until, v_state.qa_next_allowed_at, v_state.rate_limit_streak;
      return;
    end if;

    if v_state.qa_next_allowed_at is not null and v_state.qa_next_allowed_at > now() then
      v_retry := greatest(1, ceil(extract(epoch from (v_state.qa_next_allowed_at-now())))::integer);
      return query select false, 'qa_pacing', v_retry, v_state.cooldown_until, v_state.qa_cooldown_until, v_state.qa_next_allowed_at, v_state.rate_limit_streak;
      return;
    end if;
  end if;

  if v_state.active_holder is not null and v_state.active_holder <> p_holder_id then
    v_retry := greatest(1, least(10, ceil(extract(epoch from (v_state.lease_expires_at-now())))::integer));
    return query select false, 'busy', v_retry, v_state.cooldown_until, v_state.qa_cooldown_until, v_state.qa_next_allowed_at, v_state.rate_limit_streak;
    return;
  end if;

  update public.chatgpt_traffic_state
  set active_holder=p_holder_id,
      active_kind=p_client_kind,
      lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      updated_at=now()
  where singleton=true
  returning * into v_state;

  return query select true, 'granted', 0, v_state.cooldown_until, v_state.qa_cooldown_until, v_state.qa_next_allowed_at, v_state.rate_limit_streak;
end;
$function$;

revoke all on function public.acquire_chatgpt_traffic_slot(text,text,integer) from public, anon, authenticated;
grant execute on function public.acquire_chatgpt_traffic_slot(text,text,integer) to service_role;

create or replace function public.record_chatgpt_traffic_result(
  p_client_kind text,
  p_holder_id text,
  p_result text,
  p_qa_base_interval_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_state public.chatgpt_traffic_state;
  v_next_streak integer;
  v_global_cooldown_seconds integer;
  v_qa_cooldown_seconds integer;
  v_qa_interval_seconds integer;
begin
  if p_client_kind not in ('production','qa') then
    raise exception 'Unsupported ChatGPT traffic client kind: %', coalesce(p_client_kind,'<null>');
  end if;
  if p_result not in ('success','rate_limited','error') then
    raise exception 'Unsupported ChatGPT traffic result: %', coalesce(p_result,'<null>');
  end if;
  if p_qa_base_interval_seconds < 30 or p_qa_base_interval_seconds > 300 then
    raise exception 'QA base interval must be between 30 and 300 seconds';
  end if;

  select * into v_state
  from public.chatgpt_traffic_state
  where singleton=true
  for update;

  -- A rate-limit signal is global evidence even if a long request outlived its lease.
  if p_result <> 'rate_limited' and v_state.active_holder is distinct from p_holder_id then
    return jsonb_build_object('recorded',false,'reason','holder_mismatch');
  end if;

  if p_result='rate_limited' then
    v_next_streak := least(6, v_state.rate_limit_streak + 1);
    v_global_cooldown_seconds := case
      when v_next_streak=1 then 180
      when v_next_streak=2 then 300
      else 600
    end;
    v_qa_cooldown_seconds := case
      when v_next_streak=1 then 900
      when v_next_streak=2 then 1800
      else 3600
    end;

    update public.chatgpt_traffic_state
    set active_holder=null,
        active_kind=null,
        lease_expires_at=null,
        cooldown_until=greatest(coalesce(cooldown_until,now()), now()+make_interval(secs=>v_global_cooldown_seconds)),
        qa_cooldown_until=greatest(coalesce(qa_cooldown_until,now()), now()+make_interval(secs=>v_qa_cooldown_seconds)),
        last_rate_limit_at=now(),
        rate_limit_streak=v_next_streak,
        updated_at=now()
    where singleton=true
    returning * into v_state;
  elsif p_result='success' then
    v_qa_interval_seconds := p_qa_base_interval_seconds * (2 ^ least(v_state.rate_limit_streak,2));
    update public.chatgpt_traffic_state
    set active_holder=null,
        active_kind=null,
        lease_expires_at=null,
        last_success_at=now(),
        last_success_kind=p_client_kind,
        qa_next_allowed_at=case
          when p_client_kind='qa' then now()+make_interval(secs=>v_qa_interval_seconds)
          else qa_next_allowed_at
        end,
        rate_limit_streak=greatest(0,rate_limit_streak-1),
        updated_at=now()
    where singleton=true
    returning * into v_state;
  else
    update public.chatgpt_traffic_state
    set active_holder=null,
        active_kind=null,
        lease_expires_at=null,
        qa_next_allowed_at=case
          when p_client_kind='qa' then greatest(coalesce(qa_next_allowed_at,now()),now()+interval '30 seconds')
          else qa_next_allowed_at
        end,
        updated_at=now()
    where singleton=true
    returning * into v_state;
  end if;

  return jsonb_build_object(
    'recorded',true,
    'cooldownUntil',v_state.cooldown_until,
    'qaCooldownUntil',v_state.qa_cooldown_until,
    'qaNextAllowedAt',v_state.qa_next_allowed_at,
    'lastSuccessAt',v_state.last_success_at,
    'lastRateLimitAt',v_state.last_rate_limit_at,
    'rateLimitStreak',v_state.rate_limit_streak
  );
end;
$function$;

revoke all on function public.record_chatgpt_traffic_result(text,text,text,integer) from public, anon, authenticated;
grant execute on function public.record_chatgpt_traffic_result(text,text,text,integer) to service_role;

-- Live Worker Lab runs are canaries, not load tests. Repetition beyond two belongs in mock/replay coverage.
create or replace function public.request_worker_qa_run(
  p_scenario text,
  p_repetitions integer default 1
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_run_id uuid;
  v_iteration integer;
begin
  if p_scenario is null or p_scenario not in (
    'progression_target_normal',
    'quest_generation_normal',
    'search',
    'composer_recovery',
    'full_chain_normal'
  ) then
    raise exception 'Unsupported Worker QA scenario: %', coalesce(p_scenario, '<null>');
  end if;
  if p_repetitions is null or p_repetitions < 1 or p_repetitions > 2 then
    raise exception 'Live Worker QA repetitions must be between 1 and 2; use mock/replay coverage for larger batches';
  end if;

  insert into public.worker_qa_runs(scenario,repetitions,fixture_version)
  values (p_scenario,p_repetitions,'worker-qa.v1')
  returning id into v_run_id;

  for v_iteration in 1..p_repetitions loop
    insert into public.worker_qa_iterations(run_id,iteration_no)
    values (v_run_id,v_iteration);
  end loop;

  return v_run_id;
end;
$function$;

revoke all on function public.request_worker_qa_run(text,integer) from public, anon, authenticated;
grant execute on function public.request_worker_qa_run(text,integer) to service_role;

commit;
