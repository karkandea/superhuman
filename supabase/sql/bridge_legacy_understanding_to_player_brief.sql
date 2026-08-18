-- Transitional compatibility bridge for rolling out canonical Player Brief memory.
-- Keeps the legacy understanding.v1 persistence RPC safe until worker-v2 is restarted
-- onto the understanding-delta path. This bridge preserves candidate importance and
-- refreshes the canonical Player Brief exactly once per legacy batch.

create or replace function public.persist_derived_understanding(
  p_user_id uuid,
  p_candidates jsonb,
  p_knowledge_entry_ids uuid[],
  p_signal_ids uuid[] default '{}'::uuid[],
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'understanding.v1',
  p_generated_at timestamptz default now(),
  p_retrieval jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $function$
declare
  v_snapshot_id uuid;
  v_candidate jsonb;
  v_understanding_id uuid;
  v_source_id uuid;
  v_expected integer;
  v_actual integer;
begin
  if not exists (select 1 from public.users where id=p_user_id) then raise exception 'Unknown player'; end if;
  if p_candidates is null or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)=0 then raise exception 'At least one understanding candidate is required'; end if;
  if p_knowledge_entry_ids is null or cardinality(p_knowledge_entry_ids)=0 then raise exception 'Understanding persistence requires source knowledge'; end if;
  if p_retrieval is null or jsonb_typeof(p_retrieval)<>'object' then raise exception 'Retrieval metadata must be a JSON object'; end if;

  select count(*) into v_expected from (select distinct unnest(p_knowledge_entry_ids)) ids;
  select count(*) into v_actual from public.knowledge_entries where user_id=p_user_id and id=any(p_knowledge_entry_ids);
  if v_actual<>v_expected then raise exception 'Knowledge context contains missing or cross-player entries'; end if;

  select count(*) into v_expected from (select distinct unnest(coalesce(p_signal_ids,'{}'::uuid[]))) ids;
  select count(*) into v_actual from public.player_signals where user_id=p_user_id and id=any(coalesce(p_signal_ids,'{}'::uuid[]));
  if v_actual<>v_expected then raise exception 'Signal context contains missing or cross-player signals'; end if;

  insert into public.context_snapshots (user_id,purpose,summary,retrieval_metadata,generated_at)
  values (
    p_user_id,
    'understanding',
    'Evidence selected for understanding extraction',
    p_retrieval || jsonb_build_object(
      'provider_id',p_provider_id,
      'model_id',p_model_id,
      'request_id',p_request_id,
      'schema_version',p_version,
      'legacy_player_brief_bridge',true
    ),
    p_generated_at
  )
  returning id into v_snapshot_id;

  insert into public.context_snapshot_knowledge (user_id,snapshot_id,knowledge_entry_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,entry_id,ordinality::smallint,'selected raw knowledge'
  from unnest(p_knowledge_entry_ids) with ordinality as selected(entry_id,ordinality);

  insert into public.context_snapshot_signals (user_id,snapshot_id,signal_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,signal_id,ordinality::smallint,'recent derived context'
  from unnest(coalesce(p_signal_ids,'{}'::uuid[])) with ordinality as selected(signal_id,ordinality);

  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    if coalesce(v_candidate->>'summary','')='' then raise exception 'Understanding candidate summary is required'; end if;
    if not (v_candidate ? 'sourceKnowledgeEntryIds') or jsonb_typeof(v_candidate->'sourceKnowledgeEntryIds')<>'array' or jsonb_array_length(v_candidate->'sourceKnowledgeEntryIds')=0 then raise exception 'Understanding candidate requires sourceKnowledgeEntryIds'; end if;
    if (v_candidate->>'importance')::integer not between 1 and 5 then raise exception 'Understanding importance must be between 1 and 5'; end if;

    for v_source_id in select value::text::uuid from jsonb_array_elements_text(v_candidate->'sourceKnowledgeEntryIds') loop
      if not (v_source_id=any(p_knowledge_entry_ids)) or not exists (select 1 from public.knowledge_entries where id=v_source_id and user_id=p_user_id) then
        raise exception 'Understanding candidate references knowledge outside persisted context';
      end if;
    end loop;

    insert into public.derived_understanding (
      user_id,understanding_type,summary,details,confidence,importance,
      extraction_version,provider_id,model_id,model_request_id,
      first_observed_at,last_observed_at
    )
    values (
      p_user_id,
      v_candidate->>'type',
      btrim(v_candidate->>'summary'),
      coalesce(v_candidate->'details','{}'::jsonb),
      (v_candidate->>'confidence')::numeric,
      (v_candidate->>'importance')::smallint,
      p_version,p_provider_id,p_model_id,p_request_id,p_generated_at,p_generated_at
    )
    returning id into v_understanding_id;

    insert into public.understanding_sources (user_id,understanding_id,knowledge_entry_id,relation_type,evidence_excerpt)
    select p_user_id,v_understanding_id,value::text::uuid,'origin',nullif(btrim(v_candidate->>'evidenceExcerpt'),'')
    from jsonb_array_elements_text(v_candidate->'sourceKnowledgeEntryIds');

    insert into public.player_signals (user_id,source_understanding_id,signal_type,summary,importance,confidence,observed_at)
    values (
      p_user_id,
      v_understanding_id,
      v_candidate->>'type',
      btrim(v_candidate->>'summary'),
      (v_candidate->>'importance')::smallint,
      (v_candidate->>'confidence')::numeric,
      p_generated_at
    );
  end loop;

  update public.knowledge_entries
  set processing_status='processed', processing_error=null, updated_at=now()
  where user_id=p_user_id and id=any(p_knowledge_entry_ids);

  update public.knowledge_sources source
  set processing_status='processed',processing_error=null,updated_at=now()
  where source.user_id=p_user_id
    and exists (
      select 1 from public.knowledge_entries selected
      where selected.source_id=source.id
        and selected.user_id=p_user_id
        and selected.id=any(p_knowledge_entry_ids)
    )
    and not exists (
      select 1 from public.knowledge_entries remaining
      where remaining.source_id=source.id
        and remaining.user_id=p_user_id
        and remaining.processing_status not in ('processed','ignored')
    );

  -- Critical cutover bridge: an old worker may still call understanding.v1 between
  -- schema activation and service restart. Refresh exactly once after the batch so
  -- the canonical Player Brief cannot become stale during that mixed-version window.
  perform public.refresh_player_brief_internal(p_user_id,'legacy_understanding_v1_bridge');

  return v_snapshot_id;
end;
$function$;

revoke all on function public.persist_derived_understanding(uuid,jsonb,uuid[],uuid[],text,text,text,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.persist_derived_understanding(uuid,jsonb,uuid[],uuid[],text,text,text,text,timestamptz,jsonb) to service_role;
