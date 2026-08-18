import type { SupabaseClient } from '@supabase/supabase-js'
import type { PlayerContextStore } from '../context-retrieval'
import type { PlayerSignal, RecentQuestResult } from '../player-understanding'
import type { UnderstandingRepository, DailyQuestRepository } from '../ai/orchestrator'
import type { PersistedDailyQuest, QuestSource, QuestStatus } from '../quest-system'

function fail(error: { message: string } | null, operation: string) {
  if (error) throw new Error(`${operation}: ${error.message}`)
}

export function createSupabasePlayerContextStore(client: SupabaseClient): PlayerContextStore {
  return {
    async loadKnowledgeEntries(playerId, ids) {
      if (ids.length === 0) return []
      const { data, error } = await client
        .from('knowledge_entries')
        .select('id,entry_type,raw_text,occurred_at,created_at')
        .eq('user_id', playerId)
        .in('id', ids)
      fail(error, 'load knowledge context')

      const byId = new Map((data ?? []).map((row) => [row.id, row]))
      return ids.flatMap((id) => {
        const row = byId.get(id)
        if (!row) return []
        return [{ id: row.id, type: row.entry_type, text: row.raw_text, occurredAt: row.occurred_at ?? row.created_at }]
      })
    },

    async loadSignals(playerId, limit) {
      const now = new Date().toISOString()
      const { data, error } = await client
        .from('player_signals')
        .select('id,user_id,signal_type,summary,importance,confidence,observed_at,expires_at,source_understanding_id')
        .eq('user_id', playerId)
        .or(`expires_at.is.null,expires_at.gte.${now}`)
        .order('importance', { ascending: false })
        .order('observed_at', { ascending: false })
        .limit(limit)
      fail(error, 'load player signals')

      return (data ?? []).map((row) => ({
        id: row.id,
        userId: row.user_id,
        type: row.signal_type,
        summary: row.summary,
        importance: row.importance,
        confidence: Number(row.confidence),
        observedAt: row.observed_at,
        ...(row.source_understanding_id ? { sourceUnderstandingId: row.source_understanding_id } : {}),
      })) as PlayerSignal[]
    },

    async loadRecentQuestResults(playerId, limit) {
      const { data, error } = await client
        .from('quest_results')
        .select('id,quest_id,outcome,note,recorded_at')
        .eq('user_id', playerId)
        .order('recorded_at', { ascending: false })
        .limit(limit)
      fail(error, 'load quest results')

      return (data ?? []).map((row) => ({
        id: row.id,
        questId: row.quest_id,
        outcome: row.outcome,
        ...(row.note ? { note: row.note } : {}),
        recordedAt: row.recorded_at,
      })) as RecentQuestResult[]
    },
  }
}

// The persistence RPCs are deliberately service-role only. Construct these repositories
// only in trusted server code after authenticating the player and resolving playerId.
export function createSupabaseUnderstandingRepository(client: SupabaseClient): UnderstandingRepository {
  return {
    async persistDerived({ playerId, candidates, audit, context }) {
      const { error } = await client.rpc('persist_derived_understanding', {
        p_user_id: playerId,
        p_candidates: candidates,
        p_knowledge_entry_ids: context.knowledgeEntries.map((entry) => entry.id),
        p_signal_ids: context.signals.map((signal) => signal.id),
        p_provider_id: audit.providerId,
        p_model_id: audit.modelId,
        p_request_id: audit.requestId ?? null,
        p_version: audit.schemaVersion,
        p_generated_at: context.generatedAt,
        p_retrieval: context.retrieval,
      })
      fail(error, 'persist derived understanding')
    },
  }
}

function mapQuest(row: Record<string, unknown>): PersistedDailyQuest {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    batchId: String(row.batch_id),
    questDate: String(row.quest_date),
    title: String(row.title),
    category: row.category as PersistedDailyQuest['category'],
    kind: row.kind as PersistedDailyQuest['kind'],
    difficulty: row.difficulty as PersistedDailyQuest['difficulty'],
    priority: Number(row.priority) as PersistedDailyQuest['priority'],
    xp: Number(row.xp),
    rationale: String(row.rationale ?? ''),
    sourceSignalIds: Array.isArray(row.source_signal_ids) ? row.source_signal_ids.map(String) : [],
    source: row.source as QuestSource,
    status: row.status as QuestStatus,
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
  }
}

export function createSupabaseDailyQuestRepository(client: SupabaseClient): DailyQuestRepository {
  return {
    async findForDate(playerId, date) {
      const { data, error } = await client
        .from('daily_quests')
        .select('*,quest_signal_sources(signal_id)')
        .eq('user_id', playerId)
        .eq('quest_date', date)
        .order('priority', { ascending: true })
        .order('created_at', { ascending: true })
      fail(error, 'find daily quests')

      return (data ?? []).map((row) => mapQuest({
        ...row,
        source_signal_ids: (row.quest_signal_sources ?? []).map((item: { signal_id: string }) => item.signal_id),
      }))
    },

    async persistGeneratedBatch({ playerId, date, candidates, audit, context }) {
      const { data, error } = await client.rpc('persist_daily_quest_batch', {
        p_user_id: playerId,
        p_quest_date: date,
        p_signal_ids: context.signals.map((signal) => signal.id),
        p_quest_result_ids: context.recentQuestResults.map((result) => result.id),
        p_quests: candidates,
        p_provider_id: audit.providerId,
        p_model_id: audit.modelId,
        p_request_id: audit.requestId ?? null,
        p_version: audit.schemaVersion,
        p_generated_at: context.generatedAt,
        p_retrieval: context.retrieval,
      })
      fail(error, 'persist daily quest batch')

      const rows = Array.isArray(data) ? data : []
      return rows.map((row) => mapQuest(row as Record<string, unknown>))
    },
  }
}
