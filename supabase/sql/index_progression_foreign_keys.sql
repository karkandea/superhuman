-- Cover composite ownership/provenance foreign keys used by cascades and lookups.
-- Added after Supabase Performance Advisor flagged the initial foundation.

create index if not exists knowledge_entries_source_owner_idx
  on public.knowledge_entries(source_id, user_id);

create index if not exists player_signals_understanding_owner_idx
  on public.player_signals(source_understanding_id, user_id);

create index if not exists understanding_sources_understanding_owner_idx
  on public.understanding_sources(understanding_id, user_id);
create index if not exists understanding_sources_knowledge_owner_idx
  on public.understanding_sources(knowledge_entry_id, user_id);

create index if not exists context_snapshot_signals_snapshot_owner_idx
  on public.context_snapshot_signals(snapshot_id, user_id);
create index if not exists context_snapshot_signals_signal_owner_idx
  on public.context_snapshot_signals(signal_id, user_id);
create index if not exists context_snapshot_signals_user_idx
  on public.context_snapshot_signals(user_id);

create index if not exists quest_batches_context_owner_idx
  on public.quest_batches(context_snapshot_id, user_id);

create index if not exists daily_quests_batch_owner_idx
  on public.daily_quests(batch_id, user_id);

create index if not exists quest_signal_sources_quest_owner_idx
  on public.quest_signal_sources(quest_id, user_id);
create index if not exists quest_signal_sources_signal_owner_idx
  on public.quest_signal_sources(signal_id, user_id);
create index if not exists quest_signal_sources_user_idx
  on public.quest_signal_sources(user_id);

create index if not exists quest_results_quest_owner_idx
  on public.quest_results(quest_id, user_id);

create index if not exists context_snapshot_knowledge_snapshot_owner_idx
  on public.context_snapshot_knowledge(snapshot_id, user_id);
create index if not exists context_snapshot_knowledge_entry_owner_idx
  on public.context_snapshot_knowledge(knowledge_entry_id, user_id);

create index if not exists context_snapshot_quest_results_snapshot_owner_idx
  on public.context_snapshot_quest_results(snapshot_id, user_id);
create index if not exists context_snapshot_quest_results_result_owner_idx
  on public.context_snapshot_quest_results(quest_result_id, user_id);
