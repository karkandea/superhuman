begin;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'player-knowledge-audio',
  'player-knowledge-audio',
  false,
  15728640,
  array['audio/webm','audio/mp4','audio/mpeg','audio/x-m4a','audio/ogg','audio/wav']::text[]
)
on conflict(id) do update
set public=false,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists player_knowledge_audio_select_own on storage.objects;
create policy player_knowledge_audio_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id='player-knowledge-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  );

drop policy if exists player_knowledge_audio_insert_own on storage.objects;
create policy player_knowledge_audio_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id='player-knowledge-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  );

drop policy if exists player_knowledge_audio_update_own on storage.objects;
create policy player_knowledge_audio_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id='player-knowledge-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  )
  with check (
    bucket_id='player-knowledge-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  );

drop policy if exists player_knowledge_audio_delete_own on storage.objects;
create policy player_knowledge_audio_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id='player-knowledge-audio'
    and split_part(name,'/',1)=(select auth.uid())::text
  );

create or replace function public.ingest_manual_voice_knowledge(
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_duration_ms integer,
  p_occurred_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_storage_path text := btrim(coalesce(p_storage_path,''));
  v_file_name text := btrim(coalesce(p_file_name,''));
  v_mime_type text := lower(btrim(coalesce(p_mime_type,'')));
  v_source_id uuid;
  v_entry_id uuid;
  v_metadata jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if v_file_name='' or char_length(v_file_name)>200 or position('/' in v_file_name)>0 or position('..' in v_file_name)>0 then
    raise exception 'Invalid voice update file name';
  end if;
  if v_storage_path='' or v_storage_path <> concat(v_user_id::text,'/updates/',v_file_name) then
    raise exception 'Invalid voice update storage path';
  end if;
  if v_mime_type not in ('audio/webm','audio/mp4','audio/mpeg','audio/x-m4a','audio/ogg','audio/wav') then
    raise exception 'Unsupported voice update audio type';
  end if;
  if p_size_bytes is null or p_size_bytes<1 or p_size_bytes>15728640 then
    raise exception 'Voice update must be at most 15 MB';
  end if;
  if p_duration_ms is null or p_duration_ms<1 or p_duration_ms>300000 then
    raise exception 'Voice update must be at most 5 minutes';
  end if;
  if not exists(
    select 1 from storage.objects
    where bucket_id='player-knowledge-audio' and name=v_storage_path
  ) then
    raise exception 'Voice update upload was not found';
  end if;

  v_metadata := jsonb_build_object(
    'ingestion','system_update_composer',
    'input','voice',
    'storageBucket','player-knowledge-audio',
    'storagePath',v_storage_path,
    'fileName',v_file_name,
    'mimeType',v_mime_type,
    'fileSizeBytes',p_size_bytes,
    'durationMs',p_duration_ms,
    'transcriptStatus','pending'
  );

  insert into public.knowledge_sources(user_id,source_type,title,metadata,occurred_at)
  values(v_user_id,'life_update','Voice update',v_metadata,coalesce(p_occurred_at,now()))
  returning id into v_source_id;

  insert into public.knowledge_entries(user_id,source_id,entry_type,raw_text,content_metadata,occurred_at)
  values(
    v_user_id,
    v_source_id,
    'life_update',
    '[Voice update attached. Raw audio is the source evidence; transcript is pending the next reasoning cycle.]',
    v_metadata,
    coalesce(p_occurred_at,now())
  ) returning id into v_entry_id;

  return v_entry_id;
end;
$function$;

revoke all on function public.ingest_manual_voice_knowledge(text,text,text,bigint,integer,timestamptz) from public;
grant execute on function public.ingest_manual_voice_knowledge(text,text,text,bigint,integer,timestamptz) to authenticated;

create or replace function public.persist_knowledge_voice_transcripts_internal(
  p_user_id uuid,
  p_items jsonb,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_schema_version text default 'understanding-delta.v2'
)
returns integer
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_item jsonb;
  v_entry public.knowledge_entries;
  v_entry_id uuid;
  v_transcript text;
  v_count integer := 0;
begin
  if p_user_id is null then raise exception 'user id is required'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'Voice transcripts must be an array'; end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_entry_id := nullif(btrim(coalesce(v_item->>'sourceKnowledgeEntryId','')),'')::uuid;
    v_transcript := btrim(coalesce(v_item->>'transcript',''));
    if v_entry_id is null then raise exception 'Voice transcript sourceKnowledgeEntryId is required'; end if;
    if char_length(v_transcript)<1 or char_length(v_transcript)>12000 then
      raise exception 'Voice transcript must be between 1 and 12000 characters';
    end if;

    select * into v_entry
    from public.knowledge_entries
    where id=v_entry_id and user_id=p_user_id
    for update;
    if not found then raise exception 'Voice transcript knowledge entry not found' using errcode='42501'; end if;
    if v_entry.content_metadata->>'input' <> 'voice'
       or v_entry.content_metadata->>'storageBucket' <> 'player-knowledge-audio' then
      raise exception 'Knowledge entry is not voice evidence';
    end if;

    update public.knowledge_entries
    set raw_text=v_transcript,
        content_metadata=content_metadata || jsonb_build_object(
          'transcriptStatus','ready',
          'transcriptProviderId',p_provider_id,
          'transcriptModelId',p_model_id,
          'transcriptRequestId',p_request_id,
          'transcriptSchemaVersion',p_schema_version,
          'transcriptGeneratedAt',now()
        ),
        updated_at=now()
    where id=v_entry_id;

    update public.knowledge_sources
    set metadata=metadata || jsonb_build_object(
      'transcriptStatus','ready',
      'transcriptProviderId',p_provider_id,
      'transcriptModelId',p_model_id,
      'transcriptRequestId',p_request_id,
      'transcriptSchemaVersion',p_schema_version,
      'transcriptGeneratedAt',now()
    )
    where id=v_entry.source_id and user_id=p_user_id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

revoke all on function public.persist_knowledge_voice_transcripts_internal(uuid,jsonb,text,text,text,text) from public;
grant execute on function public.persist_knowledge_voice_transcripts_internal(uuid,jsonb,text,text,text,text) to service_role;

commit;
