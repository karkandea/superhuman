-- Follow-up hardening for the progression intelligence migration.
-- 1) sync only newly inserted/actually changed response events so learning is idempotent.
-- 2) allow policy-level no-quest after feasibility gating even when the strategic target was progress/maintenance.

create or replace function public.sync_quest_response_events(
  p_user_id uuid,
  p_through_date date
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_synced integer := 0;
begin
  insert into public.quest_response_events(
    user_id,quest_id,quest_date,outcome,note,quest_snapshot,strategic_chain,execution_contract,daily_context,updated_at
  )
  select
    q.user_id,
    q.id,
    q.quest_date,
    coalesce(r.outcome, case when q.status='pending' and q.quest_date < p_through_date then 'skipped' else q.status end),
    r.note,
    jsonb_build_object(
      'title',q.title,'kind',q.kind,'difficulty',q.difficulty,'priority',q.priority,'xp',q.xp,'status',q.status,
      'candidateId',q.candidate_id,'progressionTargetId',q.progression_target_id
    ),
    coalesce(q.strategic_chain,'{}'::jsonb),
    coalesce(q.execution_contract,'{}'::jsonb),
    coalesce((
      select jsonb_build_object('mode',d.mode,'text',d.context_text)
      from public.daily_contexts d
      where d.user_id=q.user_id and d.context_date=q.quest_date
    ), '{}'::jsonb),
    now()
  from public.daily_quests q
  left join public.quest_results r on r.quest_id=q.id and r.user_id=q.user_id
  where q.user_id=p_user_id
    and q.quest_date <= p_through_date
    and (
      r.id is not null
      or q.status in ('partial','skipped','failed')
      or (q.status='pending' and q.quest_date < p_through_date)
    )
  on conflict (quest_id) do update
  set outcome=excluded.outcome,
      note=excluded.note,
      quest_snapshot=excluded.quest_snapshot,
      strategic_chain=excluded.strategic_chain,
      execution_contract=excluded.execution_contract,
      daily_context=excluded.daily_context,
      inferred_barrier=null,
      effectiveness='unknown',
      effectiveness_reason='Downstream progression has not been established yet.',
      evidence_signal_ids='{}'::uuid[],
      review_confidence=0,
      review_version=null,
      reviewed_at=null,
      updated_at=now()
  where public.quest_response_events.outcome is distinct from excluded.outcome
     or public.quest_response_events.note is distinct from excluded.note
     or public.quest_response_events.quest_snapshot is distinct from excluded.quest_snapshot
     or public.quest_response_events.strategic_chain is distinct from excluded.strategic_chain
     or public.quest_response_events.execution_contract is distinct from excluded.execution_contract
     or public.quest_response_events.daily_context is distinct from excluded.daily_context;

  get diagnostics v_synced = row_count;
  return jsonb_build_object('synced',v_synced);
end;
$$;

revoke execute on function public.sync_quest_response_events(uuid,date) from public,anon,authenticated;
grant execute on function public.sync_quest_response_events(uuid,date) to service_role;

drop function if exists public.persist_no_quest_plan(uuid,date,uuid,text,text,text,text,jsonb);

create or replace function public.persist_no_quest_plan(
  p_user_id uuid,
  p_quest_date date,
  p_progression_target_id uuid,
  p_no_quest_reason text,
  p_provider_id text default null,
  p_model_id text default null,
  p_request_id text default null,
  p_version text default 'daily-quest.v3',
  p_retrieval jsonb default '{}'::jsonb
)
returns public.quest_batches
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_target public.progression_targets;
  v_snapshot_id uuid;
  v_batch public.quest_batches;
  v_reason text := nullif(btrim(p_no_quest_reason),'');
begin
  if v_reason is null then raise exception 'No-quest plan requires a reason'; end if;
  select * into v_target
  from public.progression_targets
  where id=p_progression_target_id and user_id=p_user_id and target_date=p_quest_date;
  if v_target.id is null then raise exception 'No-quest plan Progression Target mismatch'; end if;
  if exists(select 1 from public.daily_quests where user_id=p_user_id and quest_date=p_quest_date) then
    raise exception 'Cannot persist no-quest plan after quests exist';
  end if;

  select * into v_batch
  from public.quest_batches
  where user_id=p_user_id and quest_date=p_quest_date;
  if v_batch.id is not null then return v_batch; end if;

  insert into public.context_snapshots(
    user_id,context_date,purpose,summary,retrieval_metadata,generated_at,player_brief_id
  ) values (
    p_user_id,
    p_quest_date,
    'daily_quest',
    'System intentionally provided no Daily Quest',
    p_retrieval || jsonb_build_object(
      'noQuest',true,
      'noQuestReason',v_reason,
      'progressionTargetId',v_target.id,
      'progressionTargetMode',v_target.decision->>'mode',
      'schema_version',p_version
    ),
    now(),
    nullif(p_retrieval->>'playerBriefId','')::uuid
  ) returning id into v_snapshot_id;

  insert into public.quest_batches(
    user_id,quest_date,context_snapshot_id,status,provider_id,model_id,model_request_id,
    generation_version,generation_metadata,completed_at,progression_target_id
  ) values (
    p_user_id,
    p_quest_date,
    v_snapshot_id,
    'generated',
    p_provider_id,
    p_model_id,
    p_request_id,
    p_version,
    p_retrieval || jsonb_build_object(
      'noQuest',true,
      'noQuestReason',v_reason,
      'progressionTargetId',v_target.id,
      'progressionTargetMode',v_target.decision->>'mode'
    ),
    now(),
    p_progression_target_id
  ) returning * into v_batch;

  return v_batch;
end;
$$;

revoke execute on function public.persist_no_quest_plan(uuid,date,uuid,text,text,text,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.persist_no_quest_plan(uuid,date,uuid,text,text,text,text,text,jsonb)
  to service_role;
