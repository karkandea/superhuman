begin;

grant select,insert,update,delete on public.progression_sessions to service_role;
grant select,insert,update,delete on public.progression_messages to service_role;
grant select,insert,update,delete on public.progression_research to service_role;
grant select,insert,update,delete on public.progression_questions to service_role;

create or replace function public.answer_progression_question(
  p_question_id uuid,
  p_answer jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_question public.progression_questions;
  v_session public.progression_sessions;
  v_text text;
  v_source_id uuid;
  v_entry_id uuid;
  v_timezone text;
  v_target_date date;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_answer is null then raise exception 'Answer is required'; end if;

  select * into v_question from public.progression_questions
  where id=p_question_id and user_id=v_user_id and status='pending' for update;
  if not found then raise exception 'Progression question not found or already answered' using errcode='42501'; end if;

  select * into v_session from public.progression_sessions
  where id=v_question.session_id and user_id=v_user_id and status='active' for update;
  if not found then raise exception 'Active progression session not found'; end if;

  if v_question.response_type in ('free_text','short_text') then
    if jsonb_typeof(p_answer)<>'string' then raise exception 'text answer required'; end if;
    v_text := btrim(p_answer #>> '{}');
    if char_length(v_text) not between 1 and (case when v_question.response_type='short_text' then 800 else 5000 end) then
      raise exception 'answer length invalid';
    end if;
  elsif v_question.response_type='single_choice' then
    if jsonb_typeof(p_answer)<>'string'
       or not exists(
         select 1
         from jsonb_array_elements_text(v_question.options) as option_row(value)
         where option_row.value=(p_answer #>> '{}')
       ) then
      raise exception 'answer must be one supplied option';
    end if;
    v_text := p_answer #>> '{}';
  else
    if jsonb_typeof(p_answer)<>'array' or jsonb_array_length(p_answer)<1 then
      raise exception 'multiple choice answer must be a non-empty array';
    end if;
    if exists(
      select 1
      from jsonb_array_elements_text(p_answer) as answer_row(value)
      where not exists(
        select 1
        from jsonb_array_elements_text(v_question.options) as option_row(value)
        where option_row.value=answer_row.value
      )
    ) then
      raise exception 'answer contains an unknown option';
    end if;
    select string_agg(answer_row.value,', ' order by answer_row.value)
    into v_text
    from jsonb_array_elements_text(p_answer) as answer_row(value);
  end if;

  insert into public.knowledge_sources(user_id,source_type,title,metadata,occurred_at)
  values(
    v_user_id,'note','Progression conversation',
    jsonb_build_object('system','progression_conversation','sessionId',v_session.id,'questionId',v_question.id),
    now()
  ) returning id into v_source_id;

  insert into public.knowledge_entries(user_id,source_id,entry_type,raw_text,content_metadata,occurred_at)
  values(
    v_user_id,v_source_id,'note',
    format('System question: %s\nPlayer answer: %s',v_question.prompt,v_text),
    jsonb_build_object('system','progression_conversation','sessionId',v_session.id,'questionId',v_question.id),
    now()
  ) returning id into v_entry_id;

  update public.progression_questions
  set status='answered',answer=p_answer,answer_knowledge_entry_id=v_entry_id,answered_at=now(),updated_at=now()
  where id=v_question.id;

  insert into public.progression_messages(session_id,user_id,actor,message_type,body,metadata,dedupe_key)
  values(
    v_session.id,v_user_id,'player','clarification_answer',v_text,
    jsonb_build_object('questionId',v_question.id),format('question-answer:%s',v_question.id)
  )
  on conflict(session_id,dedupe_key) where dedupe_key is not null do nothing;

  update public.progression_sessions
  set state='understanding',state_metadata='{}'::jsonb,updated_at=now()
  where id=v_session.id;

  select timezone into v_timezone from public.users where id=v_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone:='UTC';
  end if;
  v_target_date := coalesce(v_session.target_date,(now() at time zone v_timezone)::date);

  perform public.request_progression_cycle(v_target_date);

  return jsonb_build_object('sessionId',v_session.id,'knowledgeEntryId',v_entry_id,'targetDate',v_target_date);
end;
$function$;

revoke all on function public.answer_progression_question(uuid,jsonb) from public,anon;
grant execute on function public.answer_progression_question(uuid,jsonb) to authenticated;

commit;
