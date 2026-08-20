begin;

alter table public.player_initialization_questions
  add column if not exists answer_mode text not null default 'text',
  add column if not exists answer_audio_storage_path text,
  add column if not exists answer_audio_file_name text,
  add column if not exists answer_audio_mime_type text,
  add column if not exists answer_audio_size_bytes bigint,
  add column if not exists answer_audio_duration_ms integer,
  add column if not exists transcript_text text,
  add column if not exists transcript_provider_id text,
  add column if not exists transcript_model_id text,
  add column if not exists transcript_request_id text,
  add column if not exists transcript_generated_at timestamptz,
  add column if not exists transcript_edited_by_player boolean not null default false,
  add column if not exists transcript_edited_at timestamptz;

alter table public.player_initialization_questions
  drop constraint if exists player_initialization_questions_answer_text_check;

alter table public.player_initialization_questions
  add constraint player_initialization_questions_answer_text_check
    check (answer_text is null or char_length(answer_text) between 1 and 12000),
  add constraint player_initialization_questions_answer_mode_check
    check (answer_mode in ('text','audio')),
  add constraint player_initialization_questions_audio_size_check
    check (answer_audio_size_bytes is null or answer_audio_size_bytes between 1 and 15728640),
  add constraint player_initialization_questions_audio_duration_check
    check (answer_audio_duration_ms is null or answer_audio_duration_ms between 1 and 300000),
  add constraint player_initialization_questions_transcript_text_check
    check (transcript_text is null or char_length(transcript_text) between 1 and 12000);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'player-initialization-audio',
  'player-initialization-audio',
  false,
  15728640,
  array['audio/webm','audio/mp4','audio/mpeg','audio/x-m4a','audio/ogg','audio/wav']::text[]
)
on conflict(id) do update
set public=false,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists player_initialization_audio_select_own on storage.objects;
create policy player_initialization_audio_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id='player-initialization-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  );

drop policy if exists player_initialization_audio_insert_own on storage.objects;
create policy player_initialization_audio_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id='player-initialization-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  );

drop policy if exists player_initialization_audio_update_own on storage.objects;
create policy player_initialization_audio_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id='player-initialization-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  )
  with check (
    bucket_id='player-initialization-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  );

drop policy if exists player_initialization_audio_delete_own on storage.objects;
create policy player_initialization_audio_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id='player-initialization-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  );

create or replace function public.submit_player_initialization_voice_answer(
  p_question_id uuid,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_duration_ms integer
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_question public.player_initialization_questions;
  v_storage_path text := btrim(coalesce(p_storage_path,''));
  v_file_name text := btrim(coalesce(p_file_name,''));
  v_mime_type text := lower(btrim(coalesce(p_mime_type,'')));
  v_source_id uuid;
  v_entry_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_question_id is null then raise exception 'question id is required'; end if;

  select * into v_question
  from public.player_initialization_questions
  where id=p_question_id and user_id=v_user_id
  for update;
  if not found then raise exception 'Initialization question not found' using errcode='42501'; end if;
  if v_question.status <> 'pending' then raise exception 'Initialization question is no longer pending'; end if;

  if v_storage_path='' or v_storage_path <> concat(v_user_id::text,'/',v_question.id::text,'/',v_file_name) then
    raise exception 'Invalid initialization audio storage path';
  end if;
  if v_file_name='' or char_length(v_file_name)>200 or position('/' in v_file_name)>0 or position('..' in v_file_name)>0 then
    raise exception 'Invalid initialization audio file name';
  end if;
  if v_mime_type not in ('audio/webm','audio/mp4','audio/mpeg','audio/x-m4a','audio/ogg','audio/wav') then
    raise exception 'Unsupported initialization audio type';
  end if;
  if p_size_bytes is null or p_size_bytes<1 or p_size_bytes>15728640 then
    raise exception 'Initialization audio must be at most 15 MB';
  end if;
  if p_duration_ms is null or p_duration_ms<1 or p_duration_ms>300000 then
    raise exception 'Initialization voice answer must be at most 5 minutes';
  end if;
  if not exists(
    select 1 from storage.objects
    where bucket_id='player-initialization-audio' and name=v_storage_path
  ) then
    raise exception 'Initialization audio upload was not found';
  end if;

  insert into public.knowledge_sources(user_id,source_type,title,metadata,occurred_at)
  values(
    v_user_id,'note','Player initialization voice answer',
    jsonb_build_object(
      'system','player_initialization',
      'answerMode','audio',
      'questionId',v_question.id,
      'questionKey',v_question.question_key,
      'dimension',v_question.dimension,
      'origin',v_question.origin,
      'calibrationVersion',v_question.calibration_version,
      'storageBucket','player-initialization-audio',
      'storagePath',v_storage_path,
      'mimeType',v_mime_type,
      'durationMs',p_duration_ms
    ),
    now()
  ) returning id into v_source_id;

  insert into public.knowledge_entries(user_id,source_id,entry_type,raw_text,content_metadata,occurred_at)
  values(
    v_user_id,v_source_id,'note',
    format('Initialization question: %s\nPlayer answer: [Voice answer attached. Raw audio is the source evidence; transcript is pending calibration.]',v_question.prompt),
    jsonb_build_object(
      'system','player_initialization',
      'answerMode','audio',
      'questionId',v_question.id,
      'questionKey',v_question.question_key,
      'dimension',v_question.dimension,
      'origin',v_question.origin,
      'calibrationVersion',v_question.calibration_version,
      'storageBucket','player-initialization-audio',
      'storagePath',v_storage_path,
      'mimeType',v_mime_type,
      'durationMs',p_duration_ms
    ),
    now()
  ) returning id into v_entry_id;

  update public.player_initialization_questions
  set status='answered',
      answer_mode='audio',
      answer_text=null,
      answer_audio_storage_path=v_storage_path,
      answer_audio_file_name=v_file_name,
      answer_audio_mime_type=v_mime_type,
      answer_audio_size_bytes=p_size_bytes,
      answer_audio_duration_ms=p_duration_ms,
      transcript_text=null,
      transcript_provider_id=null,
      transcript_model_id=null,
      transcript_request_id=null,
      transcript_generated_at=null,
      transcript_edited_by_player=false,
      transcript_edited_at=null,
      answer_knowledge_entry_id=v_entry_id,
      answered_at=now(),
      updated_at=now()
  where id=v_question.id;

  if v_question.origin='adaptive' then
    update public.player_initialization_questions
    set status='superseded',updated_at=now()
    where user_id=v_user_id
      and origin='adaptive'
      and status='pending'
      and dimension=v_question.dimension
      and id<>v_question.id;
  end if;

  update public.player_initializations
  set stage=case when v_question.origin='adaptive' then 'calibrating' else 'initializing' end,
      readiness='ask',updated_at=now()
  where user_id=v_user_id and readiness<>'ready';

  return v_entry_id;
end;
$function$;

revoke all on function public.submit_player_initialization_voice_answer(uuid,text,text,text,bigint,integer) from public;
grant execute on function public.submit_player_initialization_voice_answer(uuid,text,text,text,bigint,integer) to authenticated;

create or replace function public.persist_player_initialization_calibration_v2_internal(
  p_user_id uuid,
  p_readiness text,
  p_reason text,
  p_dimensions jsonb,
  p_questions jsonb,
  p_voice_transcripts jsonb,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_schema_version text default 'player-initialization-calibration.v2'
)
returns public.player_initializations
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_state public.player_initializations;
  v_item jsonb;
  v_question public.player_initialization_questions;
  v_question_id uuid;
  v_knowledge_entry_id uuid;
  v_transcript text;
begin
  if p_voice_transcripts is null or jsonb_typeof(p_voice_transcripts)<>'array' then
    raise exception 'Initialization voice transcripts must be an array';
  end if;

  v_state := public.persist_player_initialization_calibration_internal(
    p_user_id,
    p_readiness,
    p_reason,
    p_dimensions,
    p_questions,
    p_provider_id,
    p_model_id,
    p_request_id,
    p_schema_version
  );

  for v_item in select value from jsonb_array_elements(p_voice_transcripts)
  loop
    begin
      v_question_id := (v_item->>'questionId')::uuid;
      v_knowledge_entry_id := (v_item->>'sourceKnowledgeEntryId')::uuid;
    exception when others then
      raise exception 'Invalid initialization voice transcript provenance';
    end;
    v_transcript := btrim(coalesce(v_item->>'transcript',''));
    if char_length(v_transcript)<1 or char_length(v_transcript)>12000 then
      raise exception 'Initialization voice transcript must be between 1 and 12000 characters';
    end if;

    select * into v_question
    from public.player_initialization_questions
    where id=v_question_id and user_id=p_user_id
    for update;
    if not found then raise exception 'Initialization voice transcript question not found'; end if;
    if v_question.status<>'answered' or v_question.answer_mode<>'audio' then
      raise exception 'Initialization voice transcript must target an answered audio question';
    end if;
    if v_question.answer_knowledge_entry_id is distinct from v_knowledge_entry_id then
      raise exception 'Initialization voice transcript knowledge provenance mismatch';
    end if;

    update public.player_initialization_questions
    set transcript_text=v_transcript,
        answer_text=v_transcript,
        transcript_provider_id=nullif(btrim(coalesce(p_provider_id,'')),''),
        transcript_model_id=nullif(btrim(coalesce(p_model_id,'')),''),
        transcript_request_id=nullif(btrim(coalesce(p_request_id,'')),''),
        transcript_generated_at=now(),
        transcript_edited_by_player=false,
        transcript_edited_at=null,
        updated_at=now()
    where id=v_question.id;

    update public.knowledge_entries
    set raw_text=format('Initialization question: %s\nPlayer voice transcript: %s',v_question.prompt,v_transcript),
        content_metadata=content_metadata||jsonb_build_object(
          'voiceTranscriptAvailable',true,
          'voiceTranscriptGeneratedAt',now(),
          'voiceTranscriptProviderId',nullif(btrim(coalesce(p_provider_id,'')),''),
          'voiceTranscriptModelId',nullif(btrim(coalesce(p_model_id,'')),''),
          'voiceTranscriptRequestId',nullif(btrim(coalesce(p_request_id,'')),'')
        )
    where id=v_knowledge_entry_id and user_id=p_user_id;
  end loop;

  return v_state;
end;
$function$;

revoke all on function public.persist_player_initialization_calibration_v2_internal(uuid,text,text,jsonb,jsonb,jsonb,text,text,text,text) from public;
grant execute on function public.persist_player_initialization_calibration_v2_internal(uuid,text,text,jsonb,jsonb,jsonb,text,text,text,text) to service_role;

create or replace function public.update_player_initialization_voice_transcript(
  p_question_id uuid,
  p_transcript text
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_question public.player_initialization_questions;
  v_transcript text := btrim(coalesce(p_transcript,''));
  v_source_id uuid;
  v_entry_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_question_id is null then raise exception 'question id is required'; end if;
  if char_length(v_transcript)<1 or char_length(v_transcript)>12000 then
    raise exception 'Transcript must be between 1 and 12000 characters';
  end if;

  select * into v_question
  from public.player_initialization_questions
  where id=p_question_id and user_id=v_user_id
  for update;
  if not found then raise exception 'Initialization question not found' using errcode='42501'; end if;
  if v_question.status<>'answered' or v_question.answer_mode<>'audio' or v_question.transcript_text is null then
    raise exception 'Only generated voice transcripts can be edited';
  end if;

  update public.player_initialization_questions
  set transcript_text=v_transcript,
      answer_text=v_transcript,
      transcript_edited_by_player=true,
      transcript_edited_at=now(),
      updated_at=now()
  where id=v_question.id;

  insert into public.knowledge_sources(user_id,source_type,title,metadata,occurred_at)
  values(
    v_user_id,'note','Player initialization transcript correction',
    jsonb_build_object(
      'system','player_initialization',
      'answerMode','audio_transcript_correction',
      'questionId',v_question.id,
      'questionKey',v_question.question_key,
      'dimension',v_question.dimension,
      'origin',v_question.origin,
      'calibrationVersion',v_question.calibration_version,
      'sourceAudioKnowledgeEntryId',v_question.answer_knowledge_entry_id
    ),
    now()
  ) returning id into v_source_id;

  insert into public.knowledge_entries(user_id,source_id,entry_type,raw_text,content_metadata,occurred_at)
  values(
    v_user_id,v_source_id,'note',
    format('Player corrected the transcript for initialization question: %s\nCorrected answer: %s',v_question.prompt,v_transcript),
    jsonb_build_object(
      'system','player_initialization',
      'answerMode','audio_transcript_correction',
      'questionId',v_question.id,
      'questionKey',v_question.question_key,
      'dimension',v_question.dimension,
      'origin',v_question.origin,
      'calibrationVersion',v_question.calibration_version,
      'sourceAudioKnowledgeEntryId',v_question.answer_knowledge_entry_id
    ),
    now()
  ) returning id into v_entry_id;

  return v_entry_id;
end;
$function$;

revoke all on function public.update_player_initialization_voice_transcript(uuid,text) from public;
grant execute on function public.update_player_initialization_voice_transcript(uuid,text) to authenticated;

commit;
