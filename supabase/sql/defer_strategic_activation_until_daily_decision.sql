begin;

alter table public.player_initializations
  add column if not exists strategic_activation_pending boolean not null default false;

create or replace function public.submit_daily_context(p_target_date date, p_mode text, p_context_text text default null)
returns public.daily_contexts
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_timezone text;
  v_local_date date;
  v_text text := btrim(coalesce(p_context_text,''));
  v_context public.daily_contexts;
  v_readiness text;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if not exists(select 1 from public.users where id=v_user_id) then
    raise exception 'Authenticated account is not linked to a player' using errcode='42501';
  end if;

  select readiness into v_readiness from public.player_initializations where user_id=v_user_id;
  if coalesce(v_readiness,'ask') <> 'ready' then
    raise exception 'Player Initialization is not READY; Daily Context is blocked';
  end if;

  if p_target_date is null then raise exception 'target date is required'; end if;
  if p_mode not in ('normal','context') then raise exception 'Unsupported Daily Context mode'; end if;

  select timezone into v_timezone from public.users where id=v_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_local_date := (now() at time zone v_timezone)::date;
  if p_target_date <> v_local_date then
    raise exception 'Daily Context can only be confirmed for the player current local day';
  end if;

  if exists(select 1 from public.daily_quests where user_id=v_user_id and quest_date=p_target_date) then
    raise exception 'Daily Context is locked after Daily Quest generation; use a Life Vault update instead';
  end if;

  if p_mode='normal' and v_text<>'' then raise exception 'Normal-day check-in cannot contain custom context'; end if;
  if p_mode='context' and v_text='' then raise exception 'Tell the System what is different today'; end if;
  if octet_length(convert_to(v_text,'UTF8')) > 4096 then raise exception 'Daily Context exceeds 4 KB'; end if;

  insert into public.daily_contexts(user_id,context_date,mode,context_text)
  values(v_user_id,p_target_date,p_mode,v_text)
  on conflict(user_id,context_date) do update
  set mode=excluded.mode,
      context_text=excluded.context_text,
      updated_at=now()
  returning * into v_context;

  return v_context;
end;
$function$;

revoke all on function public.submit_daily_context(date,text,text) from public;
grant execute on function public.submit_daily_context(date,text,text) to authenticated;

create or replace function public.persist_player_initialization_calibration_internal(
  p_user_id uuid,
  p_readiness text,
  p_reason text,
  p_dimensions jsonb,
  p_questions jsonb,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_schema_version text default 'player-initialization-calibration.v1'
)
returns public.player_initializations
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_state public.player_initializations;
  v_next_version integer;
  v_question jsonb;
  v_dimension text;
  v_key text;
  v_prompt text;
  v_reason text;
  v_priority integer;
  v_sequence integer;
begin
  if p_user_id is null then raise exception 'player id is required'; end if;
  if p_readiness not in ('ask','ready') then raise exception 'Initialization readiness must be ASK or READY'; end if;
  if p_dimensions is null or jsonb_typeof(p_dimensions)<>'object' then raise exception 'Initialization dimensions must be an object'; end if;
  if p_questions is null or jsonb_typeof(p_questions)<>'array' then raise exception 'Initialization questions must be an array'; end if;
  if char_length(btrim(coalesce(p_reason,''))) < 1 then raise exception 'Initialization readiness reason is required'; end if;
  if jsonb_array_length(p_questions) > 5 then raise exception 'Initialization calibration may propose at most five questions'; end if;

  if p_readiness='ready' then
    if jsonb_array_length(p_questions)<>0 then raise exception 'READY initialization cannot include follow-up questions'; end if;
    if coalesce(p_dimensions->'direction'->>'status','')<>'sufficient'
      or coalesce(p_dimensions->'current_state'->>'status','')<>'sufficient'
      or coalesce(p_dimensions->'bottleneck_opportunity'->>'status','')<>'sufficient'
      or coalesce(p_dimensions->'capacity_constraints'->>'status','')<>'sufficient' then
      raise exception 'READY initialization requires all four readiness dimensions to be sufficient';
    end if;
  elsif jsonb_array_length(p_questions)=0 then
    raise exception 'ASK initialization requires at least one follow-up question';
  end if;

  select * into v_state from public.player_initializations where user_id=p_user_id for update;
  if not found then raise exception 'Player Initialization state not found'; end if;
  if v_state.readiness='ready' then return v_state; end if;

  v_next_version := v_state.calibration_version + 1;

  update public.player_initialization_questions
  set status='superseded',updated_at=now()
  where user_id=p_user_id and origin='adaptive' and status='pending';

  if p_readiness='ask' then
    for v_question in select value from jsonb_array_elements(p_questions)
    loop
      v_key := btrim(coalesce(v_question->>'questionKey',''));
      v_dimension := btrim(coalesce(v_question->>'dimension',''));
      v_prompt := btrim(coalesce(v_question->>'prompt',''));
      v_reason := btrim(coalesce(v_question->>'reason',''));
      v_priority := coalesce((v_question->>'priority')::integer,3);
      v_sequence := coalesce((v_question->>'sequence')::integer,0);

      if char_length(v_key)<1 or char_length(v_key)>120 then raise exception 'Invalid adaptive question key'; end if;
      if v_dimension not in ('direction','current_state','bottleneck_opportunity','capacity_constraints') then raise exception 'Invalid adaptive question dimension'; end if;
      if char_length(v_prompt)<1 or char_length(v_prompt)>1000 then raise exception 'Invalid adaptive question prompt'; end if;
      if char_length(v_reason)<1 or char_length(v_reason)>1000 then raise exception 'Invalid adaptive question reason'; end if;
      if v_priority<1 or v_priority>5 then raise exception 'Invalid adaptive question priority'; end if;
      if v_sequence<0 or v_sequence>100 then raise exception 'Invalid adaptive question sequence'; end if;

      insert into public.player_initialization_questions(
        user_id,origin,question_key,dimension,prompt,reason,priority,sequence,calibration_version,status
      ) values(
        p_user_id,'adaptive',v_key,v_dimension,v_prompt,v_reason,v_priority,v_sequence,v_next_version,'pending'
      );
    end loop;
  end if;

  update public.player_initializations
  set stage=case when p_readiness='ready' then 'ready' else 'calibrating' end,
      readiness=p_readiness,
      readiness_dimensions=p_dimensions,
      readiness_reason=btrim(p_reason),
      calibration_version=v_next_version,
      schema_version=coalesce(nullif(btrim(p_schema_version),''),'player-initialization-calibration.v1'),
      last_provider_id=nullif(btrim(coalesce(p_provider_id,'')),''),
      last_model_id=nullif(btrim(coalesce(p_model_id,'')),''),
      last_request_id=nullif(btrim(coalesce(p_request_id,'')),''),
      last_calibrated_at=now(),
      ready_at=case when p_readiness='ready' then now() else ready_at end,
      strategic_activation_pending=case when p_readiness='ready' then true else false end,
      updated_at=now()
  where user_id=p_user_id
  returning * into v_state;

  return v_state;
end;
$function$;

revoke all on function public.persist_player_initialization_calibration_internal(uuid,text,text,jsonb,jsonb,text,text,text,text) from public, anon, authenticated;
grant execute on function public.persist_player_initialization_calibration_internal(uuid,text,text,jsonb,jsonb,text,text,text,text) to service_role;

create or replace function public.request_progression_cycle(p_target_date date)
returns public.ai_inference_jobs
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_job public.ai_inference_jobs;
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
  if not exists(select 1 from public.users where id=v_user_id) then raise exception 'Authenticated account is not linked to a player' using errcode='42501'; end if;

  select readiness into v_readiness from public.player_initializations where user_id=v_user_id;
  if coalesce(v_readiness,'ask') <> 'ready' then
    raise exception 'Player Initialization is not READY; Daily Quest decision is blocked';
  end if;

  select exists(select 1 from public.quest_batches where user_id=v_user_id and quest_date=p_target_date and status='generated') into v_has_plan;
  select exists(select 1 from public.daily_contexts where user_id=v_user_id and context_date=p_target_date) into v_has_daily_context;
  if not v_has_plan and not v_has_daily_context then raise exception 'Daily Context check-in required before first Daily Quest generation'; end if;

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

revoke all on function public.request_progression_cycle(date) from public;
grant execute on function public.request_progression_cycle(date) to authenticated;

commit;
