begin;

create table if not exists public.progression_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('initial_calibration','progression','reevaluation')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  status text not null default 'active' check (status in ('active','closed')),
  state text not null default 'understanding' check (state in ('understanding','need_clarification','researching','deciding','quest_ready','waiting','stopped')),
  target_date date,
  current_job_id uuid references public.ai_inference_jobs(id) on delete set null,
  state_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(state_metadata)='object'),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists progression_sessions_one_active_per_user
  on public.progression_sessions(user_id) where status='active';
create index if not exists progression_sessions_history_idx
  on public.progression_sessions(user_id,opened_at desc);

create table if not exists public.progression_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.progression_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  actor text not null check (actor in ('player','system')),
  message_type text not null check (message_type in ('onboarding_summary','system_update','clarification_question','clarification_answer','research_update','decision','quest','wait','observation')),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  dedupe_key text,
  created_at timestamptz not null default now()
);

create unique index if not exists progression_messages_dedupe_idx
  on public.progression_messages(session_id,dedupe_key) where dedupe_key is not null;
create index if not exists progression_messages_timeline_idx
  on public.progression_messages(session_id,created_at,id);

create table if not exists public.progression_research (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.progression_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'completed' check (status in ('completed','failed')),
  topic text not null check (char_length(btrim(topic)) between 1 and 240),
  research_question text not null check (char_length(btrim(research_question)) between 1 and 1200),
  queries jsonb not null default '[]'::jsonb check (jsonb_typeof(queries)='array'),
  findings text not null check (char_length(btrim(findings)) between 1 and 8000),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources)='array'),
  provider_id text,
  model_id text,
  request_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);

create index if not exists progression_research_session_idx
  on public.progression_research(session_id,completed_at desc);

create table if not exists public.progression_questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.progression_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  response_type text not null check (response_type in ('free_text','short_text','single_choice','multiple_choice')),
  prompt text not null check (char_length(btrim(prompt)) between 1 and 1200),
  reason text not null check (char_length(btrim(reason)) between 1 and 1600),
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options)='array'),
  status text not null default 'pending' check (status in ('pending','answered','superseded')),
  answer jsonb,
  answer_knowledge_entry_id uuid references public.knowledge_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists progression_questions_one_pending_per_session
  on public.progression_questions(session_id) where status='pending';
create index if not exists progression_questions_user_idx
  on public.progression_questions(user_id,status,created_at desc);

alter table public.progression_sessions enable row level security;
alter table public.progression_messages enable row level security;
alter table public.progression_research enable row level security;
alter table public.progression_questions enable row level security;

drop policy if exists progression_sessions_select_own on public.progression_sessions;
create policy progression_sessions_select_own on public.progression_sessions for select to authenticated
  using ((select auth.uid())=user_id);
drop policy if exists progression_messages_select_own on public.progression_messages;
create policy progression_messages_select_own on public.progression_messages for select to authenticated
  using ((select auth.uid())=user_id);
drop policy if exists progression_research_select_own on public.progression_research;
create policy progression_research_select_own on public.progression_research for select to authenticated
  using ((select auth.uid())=user_id);
drop policy if exists progression_questions_select_own on public.progression_questions;
create policy progression_questions_select_own on public.progression_questions for select to authenticated
  using ((select auth.uid())=user_id);

revoke all on public.progression_sessions from anon,authenticated;
revoke all on public.progression_messages from anon,authenticated;
revoke all on public.progression_research from anon,authenticated;
revoke all on public.progression_questions from anon,authenticated;
grant select on public.progression_sessions to authenticated;
grant select on public.progression_messages to authenticated;
grant select on public.progression_research to authenticated;
grant select on public.progression_questions to authenticated;

create or replace function public.ensure_progression_session_operator(
  p_user_id uuid,
  p_target_date date,
  p_job_id uuid default null
)
returns public.progression_sessions
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_session public.progression_sessions;
  v_has_history boolean := false;
  v_has_new_result boolean := false;
  v_kind text;
  v_title text;
begin
  if p_user_id is null then raise exception 'player is required'; end if;
  if not exists(select 1 from public.users where id=p_user_id) then raise exception 'player not found'; end if;

  select * into v_session from public.progression_sessions
  where user_id=p_user_id and status='active' for update;

  if found then
    select exists(
      select 1 from public.quest_response_events e
      where e.user_id=p_user_id and e.updated_at>v_session.opened_at
    ) into v_has_new_result;

    if (v_session.state in ('quest_ready','waiting') and p_target_date is not null and v_session.target_date is not null and p_target_date>v_session.target_date)
       or (v_session.state='quest_ready' and v_has_new_result) then
      update public.progression_sessions
      set status='closed',closed_at=now(),updated_at=now()
      where id=v_session.id;
      v_session := null;
    else
      update public.progression_sessions
      set current_job_id=coalesce(p_job_id,current_job_id),
          target_date=coalesce(p_target_date,target_date),updated_at=now()
      where id=v_session.id returning * into v_session;
      return v_session;
    end if;
  end if;

  select exists(select 1 from public.progression_sessions where user_id=p_user_id) into v_has_history;
  if not v_has_history then
    v_kind := 'initial_calibration';
    v_title := 'Kalibrasi awal';
  elsif v_has_new_result then
    v_kind := 'reevaluation';
    v_title := 'Evaluasi hasil';
  else
    v_kind := 'progression';
    v_title := 'Progression berikutnya';
  end if;

  insert into public.progression_sessions(user_id,kind,title,state,target_date,current_job_id)
  values(p_user_id,v_kind,v_title,'understanding',p_target_date,p_job_id)
  returning * into v_session;
  return v_session;
end;
$function$;

revoke all on function public.ensure_progression_session_operator(uuid,date,uuid) from public,anon,authenticated;
grant execute on function public.ensure_progression_session_operator(uuid,date,uuid) to service_role;

create or replace function public.set_progression_session_state_operator(
  p_session_id uuid,
  p_state text,
  p_metadata jsonb default '{}'::jsonb
)
returns public.progression_sessions
language plpgsql
security definer
set search_path=''
as $function$
declare v_session public.progression_sessions;
begin
  if p_state not in ('understanding','need_clarification','researching','deciding','quest_ready','waiting','stopped') then
    raise exception 'invalid progression session state';
  end if;
  if jsonb_typeof(coalesce(p_metadata,'{}'::jsonb))<>'object' then raise exception 'metadata must be an object'; end if;
  update public.progression_sessions
  set state=p_state,state_metadata=coalesce(p_metadata,'{}'::jsonb),updated_at=now()
  where id=p_session_id and status='active'
  returning * into v_session;
  if not found then raise exception 'active progression session not found'; end if;
  return v_session;
end;
$function$;
revoke all on function public.set_progression_session_state_operator(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.set_progression_session_state_operator(uuid,text,jsonb) to service_role;

create or replace function public.append_progression_message_operator(
  p_session_id uuid,
  p_actor text,
  p_message_type text,
  p_body text,
  p_metadata jsonb default '{}'::jsonb,
  p_dedupe_key text default null
)
returns public.progression_messages
language plpgsql
security definer
set search_path=''
as $function$
declare v_session public.progression_sessions; v_message public.progression_messages;
begin
  select * into v_session from public.progression_sessions where id=p_session_id;
  if not found then raise exception 'progression session not found'; end if;
  if p_actor not in ('player','system') then raise exception 'invalid message actor'; end if;
  if p_message_type not in ('onboarding_summary','system_update','clarification_question','clarification_answer','research_update','decision','quest','wait','observation') then raise exception 'invalid message type'; end if;
  if char_length(btrim(coalesce(p_body,''))) not between 1 and 2000 then raise exception 'message body length invalid'; end if;
  insert into public.progression_messages(session_id,user_id,actor,message_type,body,metadata,dedupe_key)
  values(v_session.id,v_session.user_id,p_actor,p_message_type,btrim(p_body),coalesce(p_metadata,'{}'::jsonb),nullif(btrim(coalesce(p_dedupe_key,'')),''))
  on conflict(session_id,dedupe_key) where dedupe_key is not null do update set body=excluded.body,metadata=excluded.metadata
  returning * into v_message;
  return v_message;
end;
$function$;
revoke all on function public.append_progression_message_operator(uuid,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.append_progression_message_operator(uuid,text,text,text,jsonb,text) to service_role;

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
declare v_session public.progression_sessions; v_research public.progression_research; v_source jsonb;
begin
  select * into v_session from public.progression_sessions where id=p_session_id and status='active';
  if not found then raise exception 'active progression session not found'; end if;
  if jsonb_typeof(coalesce(p_queries,'[]'::jsonb))<>'array' then raise exception 'research queries must be an array'; end if;
  if jsonb_array_length(coalesce(p_queries,'[]'::jsonb))>4 then raise exception 'research queries exceed bounded maximum'; end if;
  if jsonb_typeof(coalesce(p_sources,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_sources,'[]'::jsonb))<1 then raise exception 'research requires sources'; end if;
  for v_source in select value from jsonb_array_elements(p_sources) loop
    if coalesce(v_source->>'url','') !~ '^https?://' then raise exception 'research source requires an http(s) URL'; end if;
  end loop;
  insert into public.progression_research(session_id,user_id,topic,research_question,queries,findings,sources,provider_id,model_id,request_id)
  values(v_session.id,v_session.user_id,btrim(p_topic),btrim(p_research_question),coalesce(p_queries,'[]'::jsonb),btrim(p_findings),p_sources,p_provider_id,p_model_id,p_request_id)
  returning * into v_research;
  return v_research;
end;
$function$;
revoke all on function public.persist_progression_research_operator(uuid,text,text,jsonb,text,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.persist_progression_research_operator(uuid,text,text,jsonb,text,jsonb,text,text,text) to service_role;

create or replace function public.create_progression_question_operator(
  p_session_id uuid,
  p_response_type text,
  p_prompt text,
  p_reason text,
  p_options jsonb default '[]'::jsonb
)
returns public.progression_questions
language plpgsql
security definer
set search_path=''
as $function$
declare v_session public.progression_sessions; v_question public.progression_questions;
begin
  select * into v_session from public.progression_sessions where id=p_session_id and status='active';
  if not found then raise exception 'active progression session not found'; end if;
  if p_response_type not in ('free_text','short_text','single_choice','multiple_choice') then raise exception 'invalid response type'; end if;
  if jsonb_typeof(coalesce(p_options,'[]'::jsonb))<>'array' then raise exception 'question options must be an array'; end if;
  if p_response_type in ('single_choice','multiple_choice') and jsonb_array_length(coalesce(p_options,'[]'::jsonb))<2 then raise exception 'choice question needs at least two options'; end if;
  update public.progression_questions set status='superseded',updated_at=now()
  where session_id=p_session_id and status='pending';
  insert into public.progression_questions(session_id,user_id,response_type,prompt,reason,options)
  values(v_session.id,v_session.user_id,p_response_type,btrim(p_prompt),btrim(p_reason),coalesce(p_options,'[]'::jsonb))
  returning * into v_question;
  return v_question;
end;
$function$;
revoke all on function public.create_progression_question_operator(uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_progression_question_operator(uuid,text,text,text,jsonb) to service_role;

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
  select * into v_question from public.progression_questions
  where id=p_question_id and user_id=v_user_id and status='pending' for update;
  if not found then raise exception 'Progression question not found or already answered' using errcode='42501'; end if;
  select * into v_session from public.progression_sessions where id=v_question.session_id and user_id=v_user_id and status='active' for update;
  if not found then raise exception 'Active progression session not found'; end if;

  if v_question.response_type in ('free_text','short_text') then
    if jsonb_typeof(p_answer)<>'string' then raise exception 'text answer required'; end if;
    v_text := btrim(p_answer #>> '{}');
    if char_length(v_text) not between 1 and case when v_question.response_type='short_text' then 800 else 5000 end then raise exception 'answer length invalid'; end if;
  elsif v_question.response_type='single_choice' then
    if jsonb_typeof(p_answer)<>'string' or not exists(select 1 from jsonb_array_elements_text(v_question.options) x where x=(p_answer #>> '{}')) then raise exception 'answer must be one supplied option'; end if;
    v_text := p_answer #>> '{}';
  else
    if jsonb_typeof(p_answer)<>'array' or jsonb_array_length(p_answer)<1 then raise exception 'multiple choice answer must be a non-empty array'; end if;
    if exists(select 1 from jsonb_array_elements_text(p_answer) x where not exists(select 1 from jsonb_array_elements_text(v_question.options) o where o=x)) then raise exception 'answer contains an unknown option'; end if;
    select string_agg(value,', ' order by value) into v_text from jsonb_array_elements_text(p_answer);
  end if;

  insert into public.knowledge_sources(user_id,source_type,title,metadata,occurred_at)
  values(v_user_id,'note','Progression conversation',jsonb_build_object('system','progression_conversation','sessionId',v_session.id,'questionId',v_question.id),now())
  returning id into v_source_id;
  insert into public.knowledge_entries(user_id,source_id,entry_type,raw_text,content_metadata,occurred_at)
  values(v_user_id,v_source_id,'note',format('System question: %s\nPlayer answer: %s',v_question.prompt,v_text),jsonb_build_object('system','progression_conversation','sessionId',v_session.id,'questionId',v_question.id),now())
  returning id into v_entry_id;

  update public.progression_questions
  set status='answered',answer=p_answer,answer_knowledge_entry_id=v_entry_id,answered_at=now(),updated_at=now()
  where id=v_question.id;
  insert into public.progression_messages(session_id,user_id,actor,message_type,body,metadata,dedupe_key)
  values(v_session.id,v_user_id,'player','clarification_answer',v_text,jsonb_build_object('questionId',v_question.id),format('question-answer:%s',v_question.id))
  on conflict(session_id,dedupe_key) where dedupe_key is not null do nothing;
  update public.progression_sessions set state='understanding',state_metadata='{}'::jsonb,updated_at=now() where id=v_session.id;

  select timezone into v_timezone from public.users where id=v_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone:='UTC'; end if;
  v_target_date := coalesce(v_session.target_date,(now() at time zone v_timezone)::date);
  perform public.request_progression_cycle(v_target_date);

  return jsonb_build_object('sessionId',v_session.id,'knowledgeEntryId',v_entry_id,'targetDate',v_target_date);
end;
$function$;
revoke all on function public.answer_progression_question(uuid,jsonb) from public,anon;
grant execute on function public.answer_progression_question(uuid,jsonb) to authenticated;

create or replace function public.get_progression_conversation_snapshot()
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare v_user_id uuid:=auth.uid(); v_session public.progression_sessions; v_question jsonb; v_messages jsonb; v_initial jsonb; v_recent jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into v_session from public.progression_sessions where user_id=v_user_id and status='active' order by opened_at desc limit 1;
  if not found then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'kind',kind,'state',state,'status',status,'openedAt',opened_at,'closedAt',closed_at) order by opened_at desc),'[]'::jsonb)
    into v_recent from (select * from public.progression_sessions where user_id=v_user_id order by opened_at desc limit 8) s;
    return jsonb_build_object('session',null,'messages','[]'::jsonb,'question',null,'initialAnswers','[]'::jsonb,'recentSessions',coalesce(v_recent,'[]'::jsonb));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'actor',actor,'type',message_type,'body',body,'metadata',metadata,'createdAt',created_at) order by created_at,id),'[]'::jsonb)
  into v_messages from (select * from public.progression_messages where session_id=v_session.id order by created_at desc limit 24) m;

  select jsonb_build_object('id',id,'responseType',response_type,'prompt',prompt,'reason',reason,'options',options,'createdAt',created_at)
  into v_question from public.progression_questions where session_id=v_session.id and status='pending' order by created_at desc limit 1;

  if v_session.kind='initial_calibration' then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'prompt',prompt,'answer',answer_text,'origin',origin,'answeredAt',answered_at) order by answered_at,id),'[]'::jsonb)
    into v_initial from public.player_initialization_questions where user_id=v_user_id and status='answered';
  else v_initial:='[]'::jsonb; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'kind',kind,'state',state,'status',status,'openedAt',opened_at,'closedAt',closed_at) order by opened_at desc),'[]'::jsonb)
  into v_recent from (select * from public.progression_sessions where user_id=v_user_id order by opened_at desc limit 8) s;

  return jsonb_build_object(
    'session',jsonb_build_object('id',v_session.id,'title',v_session.title,'kind',v_session.kind,'state',v_session.state,'status',v_session.status,'targetDate',v_session.target_date,'metadata',v_session.state_metadata,'openedAt',v_session.opened_at,'updatedAt',v_session.updated_at),
    'messages',coalesce(v_messages,'[]'::jsonb),'question',v_question,'initialAnswers',coalesce(v_initial,'[]'::jsonb),'recentSessions',coalesce(v_recent,'[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_progression_conversation_snapshot() from public,anon;
grant execute on function public.get_progression_conversation_snapshot() to authenticated;

create or replace function public.progression_session_on_quest_batch()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare v_session_id uuid; v_no_quest boolean:=false;
begin
  if new.status<>'generated' then return new; end if;
  select id into v_session_id from public.progression_sessions
  where user_id=new.user_id and status='active' order by opened_at desc limit 1;
  if v_session_id is null then return new; end if;
  v_no_quest:=coalesce((new.generation_metadata->>'noQuest')::boolean,false);
  update public.progression_sessions
  set state=case when v_no_quest then 'waiting' else 'quest_ready' end,
      state_metadata=coalesce(state_metadata,'{}'::jsonb)||jsonb_build_object('questBatchId',new.id,'noQuest',v_no_quest),
      updated_at=now()
  where id=v_session_id;
  return new;
end;
$function$;
revoke all on function public.progression_session_on_quest_batch() from public,anon,authenticated,service_role;
drop trigger if exists quest_batches_progression_session_state on public.quest_batches;
create trigger quest_batches_progression_session_state after insert or update of status,generation_metadata on public.quest_batches
for each row execute function public.progression_session_on_quest_batch();

commit;
