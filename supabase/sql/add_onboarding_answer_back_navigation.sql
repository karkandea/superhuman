begin;

create or replace function public.reopen_previous_player_initialization_question(
  p_current_question_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_initialization public.player_initializations;
  v_current public.player_initialization_questions;
  v_previous public.player_initialization_questions;
  v_before_sequence integer := 32767;
  v_previous_answer text;
  v_previous_mode text;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  select * into v_initialization
  from public.player_initializations
  where user_id=v_user_id
  for update;

  if not found then
    raise exception 'Player initialization not found' using errcode='42501';
  end if;

  if v_initialization.readiness='ready'
     or v_initialization.calibration_version<>0
     or v_initialization.last_calibrated_at is not null then
    raise exception 'Basic onboarding answers can no longer be reopened';
  end if;

  if p_current_question_id is not null then
    select * into v_current
    from public.player_initialization_questions
    where id=p_current_question_id
      and user_id=v_user_id
      and origin='basic'
      and status='pending'
    for update;

    if not found then
      raise exception 'Current onboarding question is not available' using errcode='42501';
    end if;

    v_before_sequence := v_current.sequence;
  end if;

  select * into v_previous
  from public.player_initialization_questions
  where user_id=v_user_id
    and origin='basic'
    and status='answered'
    and sequence < v_before_sequence
  order by sequence desc
  limit 1
  for update;

  if not found then
    return null;
  end if;

  v_previous_answer := v_previous.answer_text;
  v_previous_mode := v_previous.answer_mode;

  if v_previous.answer_knowledge_entry_id is not null then
    update public.knowledge_entries
    set processing_status='ignored',
        processing_error=null,
        updated_at=now()
    where id=v_previous.answer_knowledge_entry_id
      and user_id=v_user_id;
  end if;

  update public.player_initialization_questions
  set status='pending',
      answer_mode='text',
      answer_text=case when v_previous_mode='text' then v_previous_answer else null end,
      answer_audio_storage_path=null,
      answer_audio_file_name=null,
      answer_audio_mime_type=null,
      answer_audio_size_bytes=null,
      answer_audio_duration_ms=null,
      transcript_text=null,
      transcript_provider_id=null,
      transcript_model_id=null,
      transcript_request_id=null,
      transcript_generated_at=null,
      transcript_edited_by_player=false,
      transcript_edited_at=null,
      answer_knowledge_entry_id=null,
      answered_at=null,
      updated_at=now()
  where id=v_previous.id;

  update public.player_initializations
  set stage='initializing',
      readiness='ask',
      readiness_reason=null,
      updated_at=now()
  where user_id=v_user_id;

  return jsonb_build_object(
    'questionId',v_previous.id,
    'answerMode',case when v_previous_mode='audio' then 'audio' else 'text' end,
    'answerText',case when v_previous_mode='text' then v_previous_answer else null end
  );
end;
$function$;

revoke all on function public.reopen_previous_player_initialization_question(uuid) from public,anon;
grant execute on function public.reopen_previous_player_initialization_question(uuid) to authenticated;

commit;
