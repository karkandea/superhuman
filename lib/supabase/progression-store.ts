import type { SupabaseClient } from '@supabase/supabase-js'
import type { PlayerContextStore } from '../context-retrieval'
import type { MaterialityRepository, UnderstandingRepository, DailyQuestRepository } from '../ai/orchestrator'
import type { ActiveQuestContext, PersistedMaterialityAssessment, PersistedQuestInterrupt } from '../materiality'
import type { PlayerSignal, RecentQuestResult } from '../player-understanding'
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

    async loadActiveQuests(playerId, date) {
      const { data, error } = await client
        .from('daily_quests')
        .select('id,title,category,kind,difficulty,priority,xp,rationale,status,source,completed_at')
        .eq('user_id', playerId)
        .eq('quest_date', date)
        .in('status', ['pending', 'partial'])
        .order('priority', { ascending: true })
        .order('created_at', { ascending: true })
      fail(error, 'load active daily quests')

      return (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        category: row.category,
        kind: row.kind,
        difficulty: row.difficulty,
        priority: Number(row.priority),
        xp: Number(row.xp),
        rationale: row.rationale ?? '',
        status: row.status,
        source: row.source,
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      })) as ActiveQuestContext[]
    },

    async loadPlayerTimezone(playerId) {
      const { data, error } = await client
        .from('users')
        .select('timezone')
        .eq('id', playerId)
        .single()
      fail(error, 'load player timezone')
      return data?.timezone || 'UTC'
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
    ...(row.revision ? { revision: Number(row.revision) } : {}),
    ...(row.supersedes_quest_id ? { supersedesQuestId: String(row.supersedes_quest_id) } : {}),
    ...(row.interrupt_id ? { interruptId: String(row.interrupt_id) } : {}),
    ...(row.materiality_assessment_id ? { materialityAssessmentId: String(row.materiality_assessment_id) } : {}),
    ...(row.interrupted_at ? { interruptedAt: String(row.interrupted_at) } : {}),
    ...(row.interrupt_reason ? { interruptReason: String(row.interrupt_reason) } : {}),
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

function mapAssessment(row: Record<string, unknown>): PersistedMaterialityAssessment {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    knowledgeEntryId: String(row.knowledge_entry_id),
    targetDate: String(row.target_date),
    isMaterial: Boolean(row.is_material),
    level: row.level as PersistedMaterialityAssessment['level'],
    confidence: Number(row.confidence),
    reason: String(row.reason),
    affectedQuestIds: Array.isArray(row.affected_quest_ids) ? row.affected_quest_ids.map(String) : [],
    sourceSignalIds: Array.isArray(row.source_signal_ids) ? row.source_signal_ids.map(String) : [],
    recommendedAction: row.recommended_action as PersistedMaterialityAssessment['recommendedAction'],
    urgency: row.urgency as PersistedMaterialityAssessment['urgency'],
    disposition: row.disposition as PersistedMaterialityAssessment['disposition'],
    createdAt: String(row.created_at),
  }
}

function mapInterrupt(row: Record<string, unknown>): PersistedQuestInterrupt {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    assessmentId: String(row.assessment_id),
    questDate: String(row.quest_date),
    status: row.status as PersistedQuestInterrupt['status'],
    summary: String(row.summary),
    createdAt: String(row.created_at),
    ...(row.applied_at ? { appliedAt: String(row.applied_at) } : {}),
  }
}

export function createSupabaseMaterialityRepository(client: SupabaseClient): MaterialityRepository {
  return {
    async findAssessment({ playerId, knowledgeEntryId, date, version }) {
      const { data, error } = await client
        .from('materiality_assessments')
        .select('*')
        .eq('user_id', playerId)
        .eq('knowledge_entry_id', knowledgeEntryId)
        .eq('target_date', date)
        .eq('assessment_version', version)
        .maybeSingle()
      fail(error, 'find materiality assessment')
      return data ? mapAssessment(data as Record<string, unknown>) : null
    },

    async persistAssessment({ playerId, knowledgeEntryId, date, decision, audit, context }) {
      const { data, error } = await client.rpc('persist_materiality_assessment', {
        p_user_id: playerId,
        p_knowledge_entry_id: knowledgeEntryId,
        p_target_date: date,
        p_assessment: decision,
        p_signal_ids: context.signals.map((signal) => signal.id),
        p_active_quest_ids: context.activeQuests.map((quest) => quest.id),
        p_provider_id: audit.providerId,
        p_model_id: audit.modelId,
        p_request_id: audit.requestId ?? null,
        p_version: audit.schemaVersion,
        p_generated_at: context.generatedAt,
        p_player_timezone: context.playerTimezone,
        p_local_datetime: context.localDateTime,
        p_retrieval: context.retrieval,
      })
      fail(error, 'persist materiality assessment')
      if (!data || typeof data !== 'object') throw new Error('persist materiality assessment returned no assessment')
      return mapAssessment(data as Record<string, unknown>)
    },

    async findInterruptForAssessment(assessmentId) {
      const { data, error } = await client
        .from('quest_interrupts')
        .select('*')
        .eq('assessment_id', assessmentId)
        .maybeSingle()
      fail(error, 'find quest interrupt')
      return data ? mapInterrupt(data as Record<string, unknown>) : null
    },

    async persistInterrupt({ playerId, date, assessment, plan, audit, context, apply }) {
      const { data, error } = await client.rpc('persist_quest_interrupt', {
        p_user_id: playerId,
        p_assessment_id: assessment.id,
        p_quest_date: date,
        p_plan: plan,
        p_signal_ids: context.signals.map((signal) => signal.id),
        p_active_quest_ids: context.activeQuests.map((quest) => quest.id),
        p_provider_id: audit.providerId,
        p_model_id: audit.modelId,
        p_request_id: audit.requestId ?? null,
        p_version: audit.schemaVersion,
        p_generated_at: context.generatedAt,
        p_retrieval: context.retrieval,
        p_apply: apply,
      })
      fail(error, 'persist quest interrupt')
      if (!data || typeof data !== 'object') throw new Error('persist quest interrupt returned no interrupt')
      return mapInterrupt(data as Record<string, unknown>)
    },
  }
}
