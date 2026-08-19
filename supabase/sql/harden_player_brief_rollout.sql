-- Final production hardening for Player Brief/activity-window persistence.
-- No product/AI behavior changes: cover ownership/provenance FKs and keep owner-only RLS semantics
-- while evaluating auth.uid() once per statement.

create index if not exists context_snapshot_quests_snapshot_owner_idx on public.context_snapshot_quests(snapshot_id, user_id);
create index if not exists context_snapshot_quests_quest_owner_idx on public.context_snapshot_quests(quest_id, user_id);
create index if not exists context_snapshots_player_brief_owner_idx on public.context_snapshots(player_brief_id, user_id);

create index if not exists daily_quests_supersedes_owner_idx on public.daily_quests(supersedes_quest_id, user_id);
create index if not exists daily_quests_materiality_owner_idx on public.daily_quests(materiality_assessment_id, user_id);
create index if not exists daily_quests_interrupt_owner_idx on public.daily_quests(interrupt_id, user_id);

create index if not exists materiality_assessments_knowledge_owner_idx on public.materiality_assessments(knowledge_entry_id, user_id);
create index if not exists materiality_assessments_snapshot_owner_idx on public.materiality_assessments(context_snapshot_id, user_id);

create index if not exists player_brief_understanding_user_idx on public.player_brief_understanding_sources(user_id);
create index if not exists player_brief_understanding_brief_owner_idx on public.player_brief_understanding_sources(player_brief_id, user_id);
create index if not exists player_brief_understanding_owner_idx on public.player_brief_understanding_sources(understanding_id, user_id);

create index if not exists player_brief_signal_user_idx on public.player_brief_signal_sources(user_id);
create index if not exists player_brief_signal_brief_owner_idx on public.player_brief_signal_sources(player_brief_id, user_id);
create index if not exists player_brief_signal_owner_idx on public.player_brief_signal_sources(signal_id, user_id);

create index if not exists quest_interrupt_actions_user_idx on public.quest_interrupt_actions(user_id);
create index if not exists quest_interrupt_actions_interrupt_owner_idx on public.quest_interrupt_actions(interrupt_id, user_id);
create index if not exists quest_interrupt_actions_target_owner_idx on public.quest_interrupt_actions(target_quest_id, user_id);
create index if not exists quest_interrupt_actions_result_owner_idx on public.quest_interrupt_actions(result_quest_id, user_id);

create index if not exists quest_interrupts_assessment_owner_idx on public.quest_interrupts(assessment_id, user_id);
create index if not exists quest_interrupts_snapshot_owner_idx on public.quest_interrupts(context_snapshot_id, user_id);

create index if not exists understanding_delta_input_brief_owner_idx on public.understanding_delta_batches(input_player_brief_id, user_id);
create index if not exists understanding_delta_output_brief_owner_idx on public.understanding_delta_batches(output_player_brief_id, user_id);
create index if not exists understanding_delta_snapshot_owner_idx on public.understanding_delta_batches(context_snapshot_id, user_id);

create index if not exists understanding_transitions_user_idx on public.understanding_transitions(user_id);
create index if not exists understanding_transitions_delta_batch_idx on public.understanding_transitions(delta_batch_id);
create index if not exists understanding_transition_prior_owner_idx on public.understanding_transitions(prior_understanding_id, user_id);
create index if not exists understanding_transition_result_owner_idx on public.understanding_transitions(resulting_understanding_id, user_id);

drop policy if exists player_briefs_owner_select on public.player_briefs;
create policy player_briefs_owner_select on public.player_briefs
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists player_brief_understanding_owner_select on public.player_brief_understanding_sources;
create policy player_brief_understanding_owner_select on public.player_brief_understanding_sources
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists player_brief_signal_owner_select on public.player_brief_signal_sources;
create policy player_brief_signal_owner_select on public.player_brief_signal_sources
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists understanding_delta_batches_owner_select on public.understanding_delta_batches;
create policy understanding_delta_batches_owner_select on public.understanding_delta_batches
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists understanding_transitions_owner_select on public.understanding_transitions;
create policy understanding_transitions_owner_select on public.understanding_transitions
  for select to authenticated
  using (user_id = (select auth.uid()));
