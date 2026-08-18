-- Materiality Assessment + explicit System Interrupts.
-- Daily Quest stays stable by default; only persisted material assessments may revise today.

alter table public.knowledge_entries add column if not exists materiality_status text;
update public.knowledge_entries set materiality_status = 'not_required' where materiality_status is null;
alter table public.knowledge_entries alter column materiality_status set default 'pending';
alter table public.knowledge_entries alter column materiality_status set not null;
alter table public.knowledge_entries drop constraint if exists knowledge_entries_materiality_status_check;
alter table public.knowledge_entries add constraint knowledge_entries_materiality_status_check
  check (materiality_status in ('not_required','pending','assessed','failed'));

alter table public.context_snapshots drop constraint if exists context_snapshots_purpose_check;
alter table public.context_snapshots add constraint context_snapshots_purpose_check
  check (purpose in ('understanding','daily_quest','materiality','system_interrupt','other'));

alter table public.daily_quests drop constraint if exists daily_quests_status_check;
alter table public.daily_quests add constraint daily_quests_status_check
  check (status in ('pending','completed','partial','skipped','failed','deferred','cancelled','replaced'));
alter table public.daily_quests add column if not exists revision integer not null default 1;
alter table public.daily_quests add column if not exists supersedes_quest_id uuid;
alter table public.daily_quests add column if not exists materiality_assessment_id uuid;
alter table public.daily_quests add column if not exists interrupt_id uuid;
alter table public.daily_quests add column if not exists interrupted_at timestamptz;
alter table public.daily_quests add column if not exists interrupt_reason text;
alter table public.daily_quests drop constraint if exists daily_quests_revision_check;
alter table public.daily_quests add constraint daily_quests_revision_check check (revision > 0);

create table if not exists public.context_snapshot_quests (
  user_id uuid not null references public.users(id) on delete cascade,
  snapshot_id uuid not null,
  quest_id uuid not null,
  rank smallint not null check (rank > 0),
  inclusion_reason text not null,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, quest_id),
  constraint context_snapshot_quests_snapshot_owner_fkey
    foreign key (snapshot_id, user_id) references public.context_snapshots(id, user_id) on delete cascade,
  constraint context_snapshot_quests_quest_owner_fkey
    foreign key (quest_id, user_id) references public.daily_quests(id, user_id) on delete restrict
);

create table if not exists public.materiality_assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  knowledge_entry_id uuid not null,
  target_date date not null,
  context_snapshot_id uuid not null,
  is_material boolean not null,
  level text not null check (level in ('low','medium','high','critical')),
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  reason text not null check (char_length(btrim(reason)) > 0),
  affected_quest_ids uuid[] not null default '{}'::uuid[],
  source_signal_ids uuid[] not null default '{}'::uuid[],
  recommended_action text not null check (recommended_action in ('none','add','replace','defer','cancel','reprioritize')),
  urgency text not null check (urgency in ('none','today','immediate')),
  disposition text not null check (disposition in ('no_change','suggest','auto_interrupt')),
  provider_id text,
  model_id text,
  model_request_id text,
  assessment_version text not null,
  player_timezone text not null,
  local_datetime text not null,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, knowledge_entry_id, target_date, assessment_version),
  constraint materiality_assessments_knowledge_owner_fkey
    foreign key (knowledge_entry_id, user_id) references public.knowledge_entries(id, user_id) on delete cascade,
  constraint materiality_assessments_snapshot_owner_fkey
    foreign key (context_snapshot_id, user_id) references public.context_snapshots(id, user_id) on delete restrict
);

create table if not exists public.quest_interrupts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  assessment_id uuid not null,
  quest_date date not null,
  context_snapshot_id uuid not null,
  status text not null check (status in ('suggested','applied')),
  summary text not null check (char_length(btrim(summary)) > 0),
  provider_id text,
  model_id text,
  model_request_id text,
  generation_version text not null,
  generation_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(generation_metadata) = 'object'),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (id, user_id),
  unique (assessment_id),
  constraint quest_interrupts_assessment_owner_fkey
    foreign key (assessment_id, user_id) references public.materiality_assessments(id, user_id) on delete cascade,
  constraint quest_interrupts_snapshot_owner_fkey
    foreign key (context_snapshot_id, user_id) references public.context_snapshots(id, user_id) on delete restrict
);

create table if not exists public.quest_interrupt_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  interrupt_id uuid not null,
  ordinal smallint not null check (ordinal > 0),
  action text not null check (action in ('add','replace','defer','cancel','reprioritize')),
  target_quest_id uuid,
  result_quest_id uuid,
  new_priority smallint check (new_priority is null or new_priority between 1 and 5),
  reason text not null check (char_length(btrim(reason)) > 0),
  quest_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(quest_payload) = 'object'),
  before_state jsonb not null default '{}'::jsonb check (jsonb_typeof(before_state) = 'object'),
  after_state jsonb not null default '{}'::jsonb check (jsonb_typeof(after_state) = 'object'),
  created_at timestamptz not null default now(),
  unique (interrupt_id, ordinal),
  constraint quest_interrupt_actions_interrupt_owner_fkey
    foreign key (interrupt_id, user_id) references public.quest_interrupts(id, user_id) on delete cascade,
  constraint quest_interrupt_actions_target_owner_fkey
    foreign key (target_quest_id, user_id) references public.daily_quests(id, user_id) on delete restrict,
  constraint quest_interrupt_actions_result_owner_fkey
    foreign key (result_quest_id, user_id) references public.daily_quests(id, user_id) on delete restrict
);

alter table public.daily_quests drop constraint if exists daily_quests_supersedes_owner_fkey;
alter table public.daily_quests add constraint daily_quests_supersedes_owner_fkey
  foreign key (supersedes_quest_id, user_id) references public.daily_quests(id, user_id) on delete restrict;
alter table public.daily_quests drop constraint if exists daily_quests_materiality_owner_fkey;
alter table public.daily_quests add constraint daily_quests_materiality_owner_fkey
  foreign key (materiality_assessment_id, user_id) references public.materiality_assessments(id, user_id) on delete restrict;
alter table public.daily_quests drop constraint if exists daily_quests_interrupt_owner_fkey;
alter table public.daily_quests add constraint daily_quests_interrupt_owner_fkey
  foreign key (interrupt_id, user_id) references public.quest_interrupts(id, user_id) on delete restrict;

create index if not exists knowledge_entries_user_materiality_idx on public.knowledge_entries(user_id, materiality_status, created_at);
create index if not exists context_snapshot_quests_user_quest_idx on public.context_snapshot_quests(user_id, quest_id);
create index if not exists materiality_assessments_user_date_idx on public.materiality_assessments(user_id, target_date desc, created_at desc);
create index if not exists materiality_assessments_knowledge_idx on public.materiality_assessments(user_id, knowledge_entry_id);
create index if not exists quest_interrupts_user_date_idx on public.quest_interrupts(user_id, quest_date desc, created_at desc);
create index if not exists quest_interrupt_actions_interrupt_idx on public.quest_interrupt_actions(interrupt_id, ordinal);
create index if not exists daily_quests_interrupt_idx on public.daily_quests(user_id, quest_date, interrupt_id);

alter table public.context_snapshot_quests enable row level security;
alter table public.materiality_assessments enable row level security;
alter table public.quest_interrupts enable row level security;
alter table public.quest_interrupt_actions enable row level security;

revoke all on table public.context_snapshot_quests, public.materiality_assessments, public.quest_interrupts, public.quest_interrupt_actions from anon, authenticated;
grant select, insert, update, delete on table public.context_snapshot_quests, public.materiality_assessments, public.quest_interrupts, public.quest_interrupt_actions to service_role;
grant select on table public.context_snapshot_quests, public.materiality_assessments, public.quest_interrupts, public.quest_interrupt_actions to authenticated;

drop policy if exists context_snapshot_quests_select_own on public.context_snapshot_quests;
create policy context_snapshot_quests_select_own on public.context_snapshot_quests for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists materiality_assessments_select_own on public.materiality_assessments;
create policy materiality_assessments_select_own on public.materiality_assessments for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists quest_interrupts_select_own on public.quest_interrupts;
create policy quest_interrupts_select_own on public.quest_interrupts for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists quest_interrupt_actions_select_own on public.quest_interrupt_actions;
create policy quest_interrupt_actions_select_own on public.quest_interrupt_actions for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.mark_materiality_pending_from_understanding_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.knowledge_entries
  set materiality_status = 'pending', updated_at = now()
  where id = new.knowledge_entry_id and user_id = new.user_id;
  return new;
end;
$$;
revoke execute on function public.mark_materiality_pending_from_understanding_source() from public, anon, authenticated, service_role;
drop trigger if exists understanding_sources_mark_materiality_pending on public.understanding_sources;
create trigger understanding_sources_mark_materiality_pending
  after insert on public.understanding_sources
  for each row execute function public.mark_materiality_pending_from_understanding_source();

create or replace function public.persist_materiality_assessment(
  p_user_id uuid,
  p_knowledge_entry_id uuid,
  p_target_date date,
  p_assessment jsonb,
  p_signal_ids uuid[] default '{}'::uuid[],
  p_active_quest_ids uuid[] default '{}'::uuid[],
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'materiality.v1',
  p_generated_at timestamptz default now(),
  p_player_timezone text default 'UTC',
  p_local_datetime text default '',
  p_retrieval jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.materiality_assessments;
  v_snapshot_id uuid;
  v_assessment_id uuid;
  v_is_material boolean;
  v_level text;
  v_confidence numeric;
  v_reason text;
  v_recommended_action text;
  v_urgency text;
  v_disposition text;
  v_affected uuid[] := '{}'::uuid[];
  v_sources uuid[] := '{}'::uuid[];
  v_expected integer;
  v_actual integer;
begin
  if p_user_id is null or p_knowledge_entry_id is null or p_target_date is null then raise exception 'player, knowledge, and target date are required'; end if;
  if p_assessment is null or jsonb_typeof(p_assessment) <> 'object' then raise exception 'Materiality assessment must be an object'; end if;
  if p_retrieval is null or jsonb_typeof(p_retrieval) <> 'object' then raise exception 'Retrieval metadata must be an object'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_knowledge_entry_id::text || ':' || p_target_date::text || ':' || p_version, 0));

  select * into v_existing from public.materiality_assessments
  where user_id = p_user_id and knowledge_entry_id = p_knowledge_entry_id and target_date = p_target_date and assessment_version = p_version;
  if found then
    update public.knowledge_entries set materiality_status='assessed', updated_at=now()
    where id=p_knowledge_entry_id and user_id=p_user_id;
    return to_jsonb(v_existing);
  end if;

  if not exists (select 1 from public.knowledge_entries where id=p_knowledge_entry_id and user_id=p_user_id and processing_status='processed') then
    raise exception 'Materiality requires processed trigger knowledge';
  end if;

  v_is_material := coalesce((p_assessment->>'isMaterial')::boolean, false);
  v_level := p_assessment->>'level';
  v_confidence := (p_assessment->>'confidence')::numeric;
  v_reason := btrim(coalesce(p_assessment->>'reason',''));
  v_recommended_action := p_assessment->>'recommendedAction';
  v_urgency := p_assessment->>'urgency';

  if v_level not in ('low','medium','high','critical') then raise exception 'Invalid materiality level'; end if;
  if v_confidence < 0 or v_confidence > 1 then raise exception 'Invalid materiality confidence'; end if;
  if v_reason = '' then raise exception 'Materiality reason is required'; end if;
  if v_recommended_action not in ('none','add','replace','defer','cancel','reprioritize') then raise exception 'Invalid materiality action'; end if;
  if v_urgency not in ('none','today','immediate') then raise exception 'Invalid materiality urgency'; end if;

  select coalesce(array_agg(value::uuid), '{}'::uuid[]) into v_affected
  from jsonb_array_elements_text(coalesce(p_assessment->'affectedQuestIds','[]'::jsonb));
  select coalesce(array_agg(value::uuid), '{}'::uuid[]) into v_sources
  from jsonb_array_elements_text(coalesce(p_assessment->'sourceSignalIds','[]'::jsonb));

  if exists (select 1 from unnest(v_affected) id where not (id = any(coalesce(p_active_quest_ids,'{}'::uuid[])))) then
    raise exception 'Materiality references quest outside active context';
  end if;
  if exists (select 1 from unnest(v_sources) id where not (id = any(coalesce(p_signal_ids,'{}'::uuid[])))) then
    raise exception 'Materiality references signal outside retrieved context';
  end if;

  select count(*) into v_expected from (select distinct unnest(coalesce(p_signal_ids,'{}'::uuid[]))) x;
  select count(*) into v_actual from public.player_signals where user_id=p_user_id and id=any(coalesce(p_signal_ids,'{}'::uuid[]));
  if v_expected <> v_actual then raise exception 'Materiality signal context contains missing or cross-player signals'; end if;
  select count(*) into v_expected from (select distinct unnest(coalesce(p_active_quest_ids,'{}'::uuid[]))) x;
  select count(*) into v_actual from public.daily_quests
  where user_id=p_user_id and quest_date=p_target_date and id=any(coalesce(p_active_quest_ids,'{}'::uuid[])) and status in ('pending','partial');
  if v_expected <> v_actual then raise exception 'Materiality quest context is stale or cross-player'; end if;

  if not v_is_material then
    if v_recommended_action <> 'none' or v_urgency <> 'none' then raise exception 'Non-material assessment must recommend no change'; end if;
    v_disposition := 'no_change';
  elsif v_confidence < 0.65 or v_urgency = 'none' then
    v_disposition := 'no_change';
  elsif v_level in ('high','critical') and v_confidence >= 0.85 and v_urgency in ('today','immediate') then
    v_disposition := 'auto_interrupt';
  else
    v_disposition := 'suggest';
  end if;

  insert into public.context_snapshots(user_id,context_date,purpose,summary,retrieval_metadata,generated_at)
  values(p_user_id,p_target_date,'materiality','Trigger update + relevant signals + active quests used for materiality',
    p_retrieval || jsonb_build_object('provider_id',p_provider_id,'model_id',p_model_id,'request_id',p_request_id,'schema_version',p_version,'player_timezone',p_player_timezone,'local_datetime',p_local_datetime),
    p_generated_at)
  returning id into v_snapshot_id;

  insert into public.context_snapshot_knowledge(user_id,snapshot_id,knowledge_entry_id,rank,inclusion_reason)
  values(p_user_id,v_snapshot_id,p_knowledge_entry_id,1,'materiality trigger update');
  insert into public.context_snapshot_signals(user_id,snapshot_id,signal_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,id,ordinality::smallint,'relevant player signal'
  from unnest(coalesce(p_signal_ids,'{}'::uuid[])) with ordinality as x(id,ordinality);
  insert into public.context_snapshot_quests(user_id,snapshot_id,quest_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,id,ordinality::smallint,'active quest compared against update'
  from unnest(coalesce(p_active_quest_ids,'{}'::uuid[])) with ordinality as x(id,ordinality);

  insert into public.materiality_assessments(
    user_id,knowledge_entry_id,target_date,context_snapshot_id,is_material,level,confidence,reason,
    affected_quest_ids,source_signal_ids,recommended_action,urgency,disposition,
    provider_id,model_id,model_request_id,assessment_version,player_timezone,local_datetime,created_at
  ) values (
    p_user_id,p_knowledge_entry_id,p_target_date,v_snapshot_id,v_is_material,v_level,v_confidence,v_reason,
    v_affected,v_sources,v_recommended_action,v_urgency,v_disposition,
    p_provider_id,p_model_id,p_request_id,p_version,p_player_timezone,p_local_datetime,p_generated_at
  ) returning id into v_assessment_id;

  update public.knowledge_entries set materiality_status='assessed', updated_at=now()
  where id=p_knowledge_entry_id and user_id=p_user_id;

  return (select to_jsonb(a) from public.materiality_assessments a where a.id=v_assessment_id);
end;
$$;
revoke execute on function public.persist_materiality_assessment(uuid,uuid,date,jsonb,uuid[],uuid[],text,text,text,text,timestamptz,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.persist_materiality_assessment(uuid,uuid,date,jsonb,uuid[],uuid[],text,text,text,text,timestamptz,text,text,jsonb) to service_role;

create or replace function public.apply_quest_interrupt_internal(p_interrupt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interrupt public.quest_interrupts;
  v_assessment public.materiality_assessments;
  v_action public.quest_interrupt_actions;
  v_target public.daily_quests;
  v_result public.daily_quests;
  v_batch_id uuid;
  v_revision integer;
  v_payload jsonb;
  v_signal_id uuid;
begin
  select * into v_interrupt from public.quest_interrupts where id=p_interrupt_id for update;
  if not found then raise exception 'Interrupt not found'; end if;
  if v_interrupt.status='applied' then return to_jsonb(v_interrupt); end if;
  select * into v_assessment from public.materiality_assessments where id=v_interrupt.assessment_id and user_id=v_interrupt.user_id;
  if not found then raise exception 'Materiality assessment not found'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_interrupt.user_id::text || ':' || v_interrupt.quest_date::text, 0));
  select id into v_batch_id from public.quest_batches where user_id=v_interrupt.user_id and quest_date=v_interrupt.quest_date for update;
  if v_batch_id is null then raise exception 'Interrupt requires an existing daily quest batch'; end if;
  select coalesce(max(revision),1)+1 into v_revision from public.daily_quests where user_id=v_interrupt.user_id and quest_date=v_interrupt.quest_date;

  for v_action in select * from public.quest_interrupt_actions where interrupt_id=p_interrupt_id order by ordinal
  loop
    v_payload := v_action.quest_payload;
    if v_action.action='add' then
      insert into public.daily_quests(user_id,batch_id,quest_date,title,category,kind,difficulty,priority,xp,rationale,source,status,revision,materiality_assessment_id,interrupt_id,interrupt_reason)
      values(v_interrupt.user_id,v_batch_id,v_interrupt.quest_date,btrim(v_payload->>'title'),v_payload->>'category',v_payload->>'kind',v_payload->>'difficulty',(v_payload->>'priority')::smallint,(v_payload->>'xp')::integer,btrim(v_payload->>'rationale'),'system','pending',v_revision,v_assessment.id,v_interrupt.id,v_action.reason)
      returning * into v_result;
      for v_signal_id in select value::uuid from jsonb_array_elements_text(v_payload->'sourceSignalIds') loop
        insert into public.quest_signal_sources(user_id,quest_id,signal_id,contribution_reason)
        values(v_interrupt.user_id,v_result.id,v_signal_id,v_action.reason) on conflict do nothing;
      end loop;
      update public.quest_interrupt_actions set result_quest_id=v_result.id, after_state=to_jsonb(v_result) where id=v_action.id;
      continue;
    end if;

    select * into v_target from public.daily_quests
    where id=v_action.target_quest_id and user_id=v_interrupt.user_id and quest_date=v_interrupt.quest_date for update;
    if not found then
      update public.quest_interrupt_actions set after_state=jsonb_build_object('skipped','target_missing') where id=v_action.id;
      continue;
    end if;
    update public.quest_interrupt_actions set before_state=to_jsonb(v_target) where id=v_action.id;

    if v_target.status not in ('pending','partial') then
      update public.quest_interrupt_actions set after_state=jsonb_build_object('skipped',case when v_target.status='completed' then 'target_completed' else 'target_not_active' end,'status',v_target.status) where id=v_action.id;
      continue;
    end if;

    if v_action.action='defer' then
      update public.daily_quests set status='deferred',materiality_assessment_id=v_assessment.id,interrupt_id=v_interrupt.id,interrupted_at=now(),interrupt_reason=v_action.reason where id=v_target.id returning * into v_result;
    elsif v_action.action='cancel' then
      update public.daily_quests set status='cancelled',materiality_assessment_id=v_assessment.id,interrupt_id=v_interrupt.id,interrupted_at=now(),interrupt_reason=v_action.reason where id=v_target.id returning * into v_result;
    elsif v_action.action='reprioritize' then
      update public.daily_quests set priority=v_action.new_priority,materiality_assessment_id=v_assessment.id,interrupt_id=v_interrupt.id,interrupted_at=now(),interrupt_reason=v_action.reason where id=v_target.id returning * into v_result;
    elsif v_action.action='replace' then
      update public.daily_quests set status='replaced',materiality_assessment_id=v_assessment.id,interrupt_id=v_interrupt.id,interrupted_at=now(),interrupt_reason=v_action.reason where id=v_target.id returning * into v_result;
      update public.quest_interrupt_actions set after_state=to_jsonb(v_result) where id=v_action.id;
      insert into public.daily_quests(user_id,batch_id,quest_date,title,category,kind,difficulty,priority,xp,rationale,source,status,revision,supersedes_quest_id,materiality_assessment_id,interrupt_id,interrupt_reason)
      values(v_interrupt.user_id,v_batch_id,v_interrupt.quest_date,btrim(v_payload->>'title'),v_payload->>'category',v_payload->>'kind',v_payload->>'difficulty',(v_payload->>'priority')::smallint,(v_payload->>'xp')::integer,btrim(v_payload->>'rationale'),'system','pending',v_revision,v_target.id,v_assessment.id,v_interrupt.id,v_action.reason)
      returning * into v_result;
      for v_signal_id in select value::uuid from jsonb_array_elements_text(v_payload->'sourceSignalIds') loop
        insert into public.quest_signal_sources(user_id,quest_id,signal_id,contribution_reason)
        values(v_interrupt.user_id,v_result.id,v_signal_id,v_action.reason) on conflict do nothing;
      end loop;
      update public.quest_interrupt_actions set result_quest_id=v_result.id, after_state=after_state || jsonb_build_object('replacement',to_jsonb(v_result)) where id=v_action.id;
      continue;
    else
      raise exception 'Unsupported interrupt action';
    end if;
    update public.quest_interrupt_actions set after_state=to_jsonb(v_result) where id=v_action.id;
  end loop;

  update public.quest_interrupts set status='applied',applied_at=now() where id=p_interrupt_id returning * into v_interrupt;
  return to_jsonb(v_interrupt);
end;
$$;
revoke execute on function public.apply_quest_interrupt_internal(uuid) from public, anon, authenticated, service_role;

create or replace function public.persist_quest_interrupt(
  p_user_id uuid,
  p_assessment_id uuid,
  p_quest_date date,
  p_plan jsonb,
  p_signal_ids uuid[] default '{}'::uuid[],
  p_active_quest_ids uuid[] default '{}'::uuid[],
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'system-interrupt.v1',
  p_generated_at timestamptz default now(),
  p_retrieval jsonb default '{}'::jsonb,
  p_apply boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assessment public.materiality_assessments;
  v_existing public.quest_interrupts;
  v_snapshot_id uuid;
  v_interrupt_id uuid;
  v_action jsonb;
  v_target uuid;
  v_payload jsonb;
  v_sources uuid[];
  v_ordinal integer := 0;
begin
  if p_plan is null or jsonb_typeof(p_plan)<>'object' or jsonb_typeof(p_plan->'actions')<>'array' or jsonb_array_length(p_plan->'actions')=0 then raise exception 'Interrupt plan requires actions'; end if;
  if btrim(coalesce(p_plan->>'summary',''))='' then raise exception 'Interrupt summary is required'; end if;
  if p_retrieval is null or jsonb_typeof(p_retrieval)<>'object' then raise exception 'Retrieval metadata must be an object'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_assessment_id::text, 0));
  select * into v_existing from public.quest_interrupts where assessment_id=p_assessment_id;
  if found then return to_jsonb(v_existing); end if;

  select * into v_assessment from public.materiality_assessments where id=p_assessment_id and user_id=p_user_id and target_date=p_quest_date;
  if not found then raise exception 'Materiality assessment does not belong to player/date'; end if;
  if v_assessment.disposition='no_change' then raise exception 'No-change assessment cannot create an interrupt'; end if;
  if p_apply and v_assessment.disposition<>'auto_interrupt' then raise exception 'Only auto_interrupt assessment may auto-apply'; end if;

  if exists(select 1 from unnest(coalesce(p_active_quest_ids,'{}'::uuid[])) id where not exists(
    select 1 from public.daily_quests q where q.id=id and q.user_id=p_user_id and q.quest_date=p_quest_date and q.status in ('pending','partial')
  )) then raise exception 'Interrupt active quest context is stale'; end if;
  if exists(select 1 from unnest(coalesce(p_signal_ids,'{}'::uuid[])) id where not exists(
    select 1 from public.player_signals s where s.id=id and s.user_id=p_user_id
  )) then raise exception 'Interrupt signal context is invalid'; end if;

  for v_action in select value from jsonb_array_elements(p_plan->'actions') loop
    v_ordinal := v_ordinal + 1;
    if v_action->>'action' not in ('add','replace','defer','cancel','reprioritize') then raise exception 'Invalid interrupt action'; end if;
    if btrim(coalesce(v_action->>'reason',''))='' then raise exception 'Interrupt action reason is required'; end if;
    v_target := nullif(v_action->>'targetQuestId','')::uuid;
    if v_action->>'action'='add' and v_target is not null then raise exception 'Add cannot target existing quest'; end if;
    if v_action->>'action'<>'add' and (v_target is null or not (v_target=any(coalesce(p_active_quest_ids,'{}'::uuid[])))) then raise exception 'Interrupt targets quest outside active context'; end if;
    if v_action->>'action'='reprioritize' and ((v_action->>'newPriority')::integer not between 1 and 5) then raise exception 'Invalid reprioritize priority'; end if;
    if v_action->>'action' in ('add','replace') then
      v_payload := v_action->'quest';
      if v_payload is null or jsonb_typeof(v_payload)<>'object' then raise exception 'Add/replace requires quest payload'; end if;
      if btrim(coalesce(v_payload->>'title',''))='' or btrim(coalesce(v_payload->>'rationale',''))='' then raise exception 'Interrupt quest title/rationale required'; end if;
      if v_payload->>'category' not in ('pagi','siang','malam','sepanjang_hari') or v_payload->>'kind' not in ('main','side','maintenance','bonus') or v_payload->>'difficulty' not in ('easy','medium','hard') then raise exception 'Invalid interrupt quest shape'; end if;
      if (v_payload->>'priority')::integer not between 1 and 5 or (v_payload->>'xp')::integer < 0 then raise exception 'Invalid interrupt quest priority/xp'; end if;
      select coalesce(array_agg(value::uuid),'{}'::uuid[]) into v_sources from jsonb_array_elements_text(v_payload->'sourceSignalIds');
      if cardinality(v_sources)=0 or exists(select 1 from unnest(v_sources) id where not (id=any(coalesce(p_signal_ids,'{}'::uuid[])))) then raise exception 'Interrupt quest references signal outside context'; end if;
    end if;
  end loop;

  insert into public.context_snapshots(user_id,context_date,purpose,summary,retrieval_metadata,generated_at)
  values(p_user_id,p_quest_date,'system_interrupt','Context used to plan explicit Daily Quest revision',
    p_retrieval || jsonb_build_object('provider_id',p_provider_id,'model_id',p_model_id,'request_id',p_request_id,'schema_version',p_version,'assessment_id',p_assessment_id),p_generated_at)
  returning id into v_snapshot_id;
  insert into public.context_snapshot_knowledge(user_id,snapshot_id,knowledge_entry_id,rank,inclusion_reason)
  values(p_user_id,v_snapshot_id,v_assessment.knowledge_entry_id,1,'material update that triggered interrupt');
  insert into public.context_snapshot_signals(user_id,snapshot_id,signal_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,id,ordinality::smallint,'signal available to interrupt planner' from unnest(coalesce(p_signal_ids,'{}'::uuid[])) with ordinality x(id,ordinality);
  insert into public.context_snapshot_quests(user_id,snapshot_id,quest_id,rank,inclusion_reason)
  select p_user_id,v_snapshot_id,id,ordinality::smallint,'active quest available to interrupt planner' from unnest(coalesce(p_active_quest_ids,'{}'::uuid[])) with ordinality x(id,ordinality);

  insert into public.quest_interrupts(user_id,assessment_id,quest_date,context_snapshot_id,status,summary,provider_id,model_id,model_request_id,generation_version,generation_metadata,created_at)
  values(p_user_id,p_assessment_id,p_quest_date,v_snapshot_id,'suggested',btrim(p_plan->>'summary'),p_provider_id,p_model_id,p_request_id,p_version,p_retrieval,p_generated_at)
  returning id into v_interrupt_id;

  v_ordinal := 0;
  for v_action in select value from jsonb_array_elements(p_plan->'actions') loop
    v_ordinal := v_ordinal + 1;
    insert into public.quest_interrupt_actions(user_id,interrupt_id,ordinal,action,target_quest_id,new_priority,reason,quest_payload)
    values(p_user_id,v_interrupt_id,v_ordinal,(v_action->>'action'),nullif(v_action->>'targetQuestId','')::uuid,nullif(v_action->>'newPriority','')::smallint,btrim(v_action->>'reason'),coalesce(v_action->'quest','{}'::jsonb));
  end loop;

  if p_apply then return public.apply_quest_interrupt_internal(v_interrupt_id); end if;
  return (select to_jsonb(i) from public.quest_interrupts i where i.id=v_interrupt_id);
end;
$$;
revoke execute on function public.persist_quest_interrupt(uuid,uuid,date,jsonb,uuid[],uuid[],text,text,text,text,timestamptz,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.persist_quest_interrupt(uuid,uuid,date,jsonb,uuid[],uuid[],text,text,text,text,timestamptz,jsonb,boolean) to service_role;

create or replace function public.apply_suggested_quest_interrupt(p_interrupt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_interrupt public.quest_interrupts;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into v_interrupt from public.quest_interrupts where id=p_interrupt_id and user_id=v_user_id for update;
  if not found then raise exception 'Interrupt not found for authenticated player' using errcode='42501'; end if;
  return public.apply_quest_interrupt_internal(p_interrupt_id);
end;
$$;
revoke execute on function public.apply_suggested_quest_interrupt(uuid) from public, anon;
grant execute on function public.apply_suggested_quest_interrupt(uuid) to authenticated, service_role;

create or replace function public.set_daily_quest_completion(p_quest_id uuid,p_completed boolean)
returns void
language plpgsql
security invoker
set search_path=''
as $$
declare v_user_id uuid:=auth.uid(); v_status text; v_updated integer;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select status into v_status from public.daily_quests where id=p_quest_id and user_id=v_user_id for update;
  if v_status is null then raise exception 'Quest not found for authenticated player' using errcode='42501'; end if;
  if v_status in ('deferred','cancelled','replaced','skipped','failed') then raise exception 'Historical or interrupted quest cannot be toggled'; end if;
  update public.daily_quests set status=case when p_completed then 'completed' else 'pending' end,
    completed_at=case when p_completed then now() else null end
  where id=p_quest_id and user_id=v_user_id;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then raise exception 'Quest not found for authenticated player' using errcode='42501'; end if;
  if p_completed then
    insert into public.quest_results(user_id,quest_id,outcome,recorded_at) values(v_user_id,p_quest_id,'completed',now())
    on conflict(quest_id) do update set outcome='completed',recorded_at=now();
  else
    delete from public.quest_results where user_id=v_user_id and quest_id=p_quest_id;
  end if;
end;
$$;
revoke execute on function public.set_daily_quest_completion(uuid,boolean) from public, anon;
grant execute on function public.set_daily_quest_completion(uuid,boolean) to authenticated, service_role;
