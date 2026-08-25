begin;

create or replace function public.answer_progression_question_voice(
  p_question_id uuid,
  p_knowledge_entry_id uuid
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
  v_entry public.knowledge_entries;
  v_timezone text;
  v_target_date date;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;

  select * into v_question
  from public.progression_questions
  where id=p_question_id and user_id=v_user_id and status='pending'
  for update;
  if not found then raise exception 'Progression question not found or already answered' using errcode='42501'; end if;
  if v_question.response_type not in ('free_text','short_text') then
    raise exception 'Voice answer is only available for text questions';
  end if;

  select * into v_session
  from public.progression_sessions
  where id=v_question.session_id and user_id=v_user_id and status='active'
  for update;
  if not found then raise exception 'Active progression session not found'; end if;

  select * into v_entry
  from public.knowledge_entries
  where id=p_knowledge_entry_id and user_id=v_user_id
  for update;
  if not found then raise exception 'Voice knowledge entry not found' using errcode='42501'; end if;
  if v_entry.content_metadata->>'input' <> 'voice'
     or v_entry.content_metadata->>'storageBucket' <> 'player-knowledge-audio' then
    raise exception 'Knowledge entry is not voice evidence';
  end if;

  update public.knowledge_entries
  set content_metadata=content_metadata || jsonb_build_object(
        'system','progression_conversation',
        'sessionId',v_session.id,
        'questionId',v_question.id,
        'voiceRole','clarification_answer'
      ),
      updated_at=now()
  where id=v_entry.id;

  update public.knowledge_sources
  set metadata=metadata || jsonb_build_object(
        'system','progression_conversation',
        'sessionId',v_session.id,
        'questionId',v_question.id,
        'voiceRole','clarification_answer'
      )
  where id=v_entry.source_id and user_id=v_user_id;

  update public.progression_questions
  set status='answered',
      answer=jsonb_build_object('mode','voice','knowledgeEntryId',v_entry.id),
      answer_knowledge_entry_id=v_entry.id,
      answered_at=now(),
      updated_at=now()
  where id=v_question.id;

  insert into public.progression_messages(session_id,user_id,actor,message_type,body,metadata,dedupe_key)
  values(
    v_session.id,v_user_id,'player','clarification_answer','🎙 Jawaban suara',
    jsonb_build_object('questionId',v_question.id,'knowledgeEntryId',v_entry.id,'answerMode','voice'),
    format('question-answer:%s',v_question.id)
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

  return jsonb_build_object(
    'sessionId',v_session.id,
    'knowledgeEntryId',v_entry.id,
    'targetDate',v_target_date,
    'answerMode','voice'
  );
end;
$function$;

revoke all on function public.answer_progression_question_voice(uuid,uuid) from public,anon;
grant execute on function public.answer_progression_question_voice(uuid,uuid) to authenticated;

commit;
