begin;

create unique index if not exists progression_research_session_request_id_idx
  on public.progression_research(session_id,request_id)
  where request_id is not null;

create or replace function public.persist_progression_research_operator(
  p_session_id uuid,
  p_topic text,
  p_research_question text,
  p_queries jsonb,
  p_findings text,
  p_sources jsonb,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null
)
returns public.progression_research
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_session public.progression_sessions;
  v_research public.progression_research;
  v_source jsonb;
begin
  select * into v_session
  from public.progression_sessions
  where id=p_session_id and status='active';
  if not found then raise exception 'active progression session not found'; end if;

  if p_request_id is not null then
    select * into v_research
    from public.progression_research
    where session_id=p_session_id and request_id=p_request_id
    limit 1;
    if found then return v_research; end if;
  end if;

  if jsonb_typeof(coalesce(p_queries,'[]'::jsonb))<>'array' then raise exception 'research queries must be an array'; end if;
  if jsonb_array_length(coalesce(p_queries,'[]'::jsonb))>4 then raise exception 'research queries exceed bounded maximum'; end if;
  if jsonb_typeof(coalesce(p_sources,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_sources,'[]'::jsonb))<1 then raise exception 'research requires sources'; end if;

  for v_source in select value from jsonb_array_elements(p_sources) loop
    if coalesce(v_source->>'url','') !~ '^https?://' then
      raise exception 'research source requires an http(s) URL';
    end if;
  end loop;

  insert into public.progression_research(
    session_id,user_id,topic,research_question,queries,findings,sources,provider_id,model_id,request_id
  )
  values(
    v_session.id,v_session.user_id,btrim(p_topic),btrim(p_research_question),
    coalesce(p_queries,'[]'::jsonb),btrim(p_findings),p_sources,p_provider_id,p_model_id,p_request_id
  )
  on conflict (session_id,request_id) where request_id is not null
  do update set request_id=excluded.request_id
  returning * into v_research;

  return v_research;
end;
$function$;

revoke all on function public.persist_progression_research_operator(uuid,text,text,jsonb,text,jsonb,text,text,text)
  from public,anon,authenticated;
grant execute on function public.persist_progression_research_operator(uuid,text,text,jsonb,text,jsonb,text,text,text)
  to service_role;

commit;
