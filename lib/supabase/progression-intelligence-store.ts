import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModelAudit } from '../ai/contracts'
import {
  PLAYER_RESPONSE_MODEL_VERSION,
  PROGRESSION_MAP_VERSION,
  PROGRESSION_TARGET_VERSION,
  QUEST_RESPONSE_REVIEW_VERSION,
  type PlayerResponseModelBody,
  type PlayerResponseModelSnapshot,
  type ProgressionMapBody,
  type ProgressionMapSnapshot,
  type ProgressionTargetDecision,
  type ProgressionTargetSnapshot,
  type QuestExecutionContract,
  type QuestResponseEvent,
  type QuestResponseReview,
  type QuestStrategicChain,
} from '../progression-intelligence'

function fail(error: { message: string } | null, operation: string) {
  if (error) throw new Error(`${operation}: ${error.message}`)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function mapProgressionMap(row: Record<string, unknown>): ProgressionMapSnapshot {
  const body = asRecord(row.map)
  return {
    id: String(row.id),
    version: Number(row.version),
    schemaVersion: String(row.schema_version ?? PROGRESSION_MAP_VERSION),
    reason: String(row.reason ?? 'strategic_state_refresh'),
    generatedAt: String(row.generated_at ?? row.created_at),
    createdAt: String(row.created_at),
    goals: asArray(body.goals),
    proximalOutcomes: asArray(body.proximalOutcomes),
    bottlenecks: asArray(body.bottlenecks),
    opportunities: asArray(body.opportunities),
    uncertainties: asArray(body.uncertainties).map(String),
  } as ProgressionMapSnapshot
}

function mapResponseModel(row: Record<string, unknown>): PlayerResponseModelSnapshot {
  const body = asRecord(row.model)
  return {
    id: String(row.id),
    version: Number(row.version),
    schemaVersion: String(row.schema_version ?? PLAYER_RESPONSE_MODEL_VERSION),
    reason: String(row.reason ?? 'behavioral_state_refresh'),
    generatedAt: String(row.generated_at ?? row.created_at),
    createdAt: String(row.created_at),
    executionPatterns: asArray(body.executionPatterns),
    difficultyCalibration: asArray(body.difficultyCalibration),
    receptivityPatterns: asArray(body.receptivityPatterns),
    strategyEvidence: asArray(body.strategyEvidence),
    uncertainties: asArray(body.uncertainties).map(String),
  } as PlayerResponseModelSnapshot
}

function mapTarget(row: Record<string, unknown>): ProgressionTargetSnapshot {
  const decision = asRecord(row.decision) as unknown as ProgressionTargetDecision
  return {
    id: String(row.id),
    userId: String(row.user_id),
    targetDate: String(row.target_date),
    progressionMapId: String(row.progression_map_id),
    ...(row.player_response_model_id ? { playerResponseModelId: String(row.player_response_model_id) } : {}),
    dailyContextId: String(row.daily_context_id),
    schemaVersion: String(row.schema_version ?? PROGRESSION_TARGET_VERSION),
    createdAt: String(row.created_at),
    ...decision,
  }
}

function mapQuestResponse(row: Record<string, unknown>): QuestResponseEvent {
  const quest = asRecord(row.quest_snapshot)
  const strategicChain = asRecord(row.strategic_chain)
  const executionContract = asRecord(row.execution_contract)
  const dailyContext = asRecord(row.daily_context)
  return {
    id: String(row.id),
    questId: String(row.quest_id),
    questDate: String(row.quest_date),
    title: String(quest.title ?? ''),
    kind: String(quest.kind ?? ''),
    difficulty: String(quest.difficulty ?? ''),
    outcome: row.outcome as QuestResponseEvent['outcome'],
    ...(row.note ? { note: String(row.note) } : {}),
    ...(Object.keys(strategicChain).length > 0 ? { strategicChain: strategicChain as unknown as QuestStrategicChain } : {}),
    ...(Object.keys(executionContract).length > 0 ? { executionContract: executionContract as unknown as QuestExecutionContract } : {}),
    ...(Object.keys(dailyContext).length > 0 ? {
      dailyContext: {
        mode: dailyContext.mode === 'normal' ? 'normal' : 'context',
        text: String(dailyContext.text ?? ''),
      },
    } : {}),
    ...(row.inferred_barrier ? { inferredBarrier: String(row.inferred_barrier) } : {}),
    effectiveness: row.effectiveness as QuestResponseEvent['effectiveness'],
    effectivenessReason: String(row.effectiveness_reason ?? ''),
    evidenceSignalIds: asArray(row.evidence_signal_ids).map(String),
    ...(row.reviewed_at ? { reviewedAt: String(row.reviewed_at) } : {}),
  }
}

export interface QuestIntelligenceMetadataItem {
  questId: string
  candidateId: string
  strategicChain: QuestStrategicChain
  executionContract: QuestExecutionContract
}

export interface ProgressionIntelligenceStore {
  loadCurrentProgressionMap(playerId: string): Promise<ProgressionMapSnapshot | null>
  loadCurrentPlayerResponseModel(playerId: string): Promise<PlayerResponseModelSnapshot | null>
  loadProgressionTargetForDate(playerId: string, date: string): Promise<ProgressionTargetSnapshot | null>
  loadQuestResponseEvents(playerId: string, limit: number): Promise<QuestResponseEvent[]>
  syncQuestResponseEvents(playerId: string, throughDate: string): Promise<number>
  persistProgressionMap(input: {
    playerId: string
    map: ProgressionMapBody
    signalIds: string[]
    audit: ModelAudit
    reason?: string
    generatedAt: string
  }): Promise<ProgressionMapSnapshot>
  persistQuestResponseReviews(input: {
    playerId: string
    reviews: QuestResponseReview[]
  }): Promise<number>
  persistPlayerResponseModel(input: {
    playerId: string
    model: PlayerResponseModelBody
    questIds: string[]
    audit: ModelAudit
    reason?: string
    generatedAt: string
  }): Promise<PlayerResponseModelSnapshot>
  persistProgressionTarget(input: {
    playerId: string
    date: string
    progressionMapId: string
    playerResponseModelId?: string
    dailyContextId: string
    decision: ProgressionTargetDecision
    audit: ModelAudit
  }): Promise<ProgressionTargetSnapshot>
  attachQuestMetadata(input: {
    playerId: string
    date: string
    progressionTargetId: string
    items: QuestIntelligenceMetadataItem[]
  }): Promise<void>
  persistNoQuestPlan(input: {
    playerId: string
    date: string
    progressionTargetId: string
    audit: ModelAudit
    retrieval: Record<string, unknown>
  }): Promise<void>
  hasFinalizedPlanForDate(playerId: string, date: string): Promise<boolean>
  hasNoQuestPlanForDate(playerId: string, date: string): Promise<boolean>
}

export function createSupabaseProgressionIntelligenceStore(client: SupabaseClient): ProgressionIntelligenceStore {
  return {
    async loadCurrentProgressionMap(playerId) {
      const { data, error } = await client
        .from('progression_maps')
        .select('*')
        .eq('user_id', playerId)
        .eq('is_current', true)
        .maybeSingle()
      fail(error, 'load current Progression Map')
      return data ? mapProgressionMap(data as Record<string, unknown>) : null
    },

    async loadCurrentPlayerResponseModel(playerId) {
      const { data, error } = await client
        .from('player_response_models')
        .select('*')
        .eq('user_id', playerId)
        .eq('is_current', true)
        .maybeSingle()
      fail(error, 'load current Player Response Model')
      return data ? mapResponseModel(data as Record<string, unknown>) : null
    },

    async loadProgressionTargetForDate(playerId, date) {
      const { data, error } = await client
        .from('progression_targets')
        .select('*')
        .eq('user_id', playerId)
        .eq('target_date', date)
        .maybeSingle()
      fail(error, 'load Progression Target')
      return data ? mapTarget(data as Record<string, unknown>) : null
    },

    async loadQuestResponseEvents(playerId, limit) {
      const { data, error } = await client
        .from('quest_response_events')
        .select('*')
        .eq('user_id', playerId)
        .order('quest_date', { ascending: false })
        .order('updated_at', { ascending: false })
        .limit(Math.max(1, limit))
      fail(error, 'load quest response events')
      return (data ?? []).map(row => mapQuestResponse(row as Record<string, unknown>))
    },

    async syncQuestResponseEvents(playerId, throughDate) {
      const { data, error } = await client.rpc('sync_quest_response_events', {
        p_user_id: playerId,
        p_through_date: throughDate,
      })
      fail(error, 'sync quest response events')
      const result = asRecord(data)
      return Number(result.synced ?? 0)
    },

    async persistProgressionMap({ playerId, map, signalIds, audit, reason, generatedAt }) {
      const { data, error } = await client.rpc('persist_progression_map', {
        p_user_id: playerId,
        p_map: map,
        p_signal_ids: signalIds,
        p_provider_id: audit.providerId,
        p_model_id: audit.modelId,
        p_request_id: audit.requestId ?? null,
        p_version: PROGRESSION_MAP_VERSION,
        p_reason: reason ?? 'strategic_state_refresh',
        p_generated_at: generatedAt,
      })
      fail(error, 'persist Progression Map')
      if (!data || typeof data !== 'object') throw new Error('persist Progression Map returned no snapshot')
      return mapProgressionMap(data as Record<string, unknown>)
    },

    async persistQuestResponseReviews({ playerId, reviews }) {
      const { data, error } = await client.rpc('persist_quest_response_reviews', {
        p_user_id: playerId,
        p_reviews: reviews,
        p_version: QUEST_RESPONSE_REVIEW_VERSION,
      })
      fail(error, 'persist quest response reviews')
      return Number(data ?? 0)
    },

    async persistPlayerResponseModel({ playerId, model, questIds, audit, reason, generatedAt }) {
      const { data, error } = await client.rpc('persist_player_response_model', {
        p_user_id: playerId,
        p_model: model,
        p_quest_ids: questIds,
        p_provider_id: audit.providerId,
        p_model_id: audit.modelId,
        p_request_id: audit.requestId ?? null,
        p_version: PLAYER_RESPONSE_MODEL_VERSION,
        p_reason: reason ?? 'behavioral_state_refresh',
        p_generated_at: generatedAt,
      })
      fail(error, 'persist Player Response Model')
      if (!data || typeof data !== 'object') throw new Error('persist Player Response Model returned no snapshot')
      return mapResponseModel(data as Record<string, unknown>)
    },

    async persistProgressionTarget({ playerId, date, progressionMapId, playerResponseModelId, dailyContextId, decision, audit }) {
      const { data, error } = await client.rpc('persist_progression_target', {
        p_user_id: playerId,
        p_target_date: date,
        p_progression_map_id: progressionMapId,
        p_player_response_model_id: playerResponseModelId ?? null,
        p_daily_context_id: dailyContextId,
        p_decision: decision,
        p_provider_id: audit.providerId,
        p_model_id: audit.modelId,
        p_request_id: audit.requestId ?? null,
        p_version: PROGRESSION_TARGET_VERSION,
      })
      fail(error, 'persist Progression Target')
      if (!data || typeof data !== 'object') throw new Error('persist Progression Target returned no snapshot')
      return mapTarget(data as Record<string, unknown>)
    },

    async attachQuestMetadata({ playerId, date, progressionTargetId, items }) {
      const { error } = await client.rpc('attach_quest_intelligence_metadata', {
        p_user_id: playerId,
        p_quest_date: date,
        p_progression_target_id: progressionTargetId,
        p_items: items.map(item => ({
          questId: item.questId,
          candidateId: item.candidateId,
          strategicChain: item.strategicChain,
          executionContract: item.executionContract,
        })),
      })
      fail(error, 'attach quest intelligence metadata')
    },

    async persistNoQuestPlan({ playerId, date, progressionTargetId, audit, retrieval }) {
      const { error } = await client.rpc('persist_no_quest_plan', {
        p_user_id: playerId,
        p_quest_date: date,
        p_progression_target_id: progressionTargetId,
        p_provider_id: audit.providerId,
        p_model_id: audit.modelId,
        p_request_id: audit.requestId ?? null,
        p_version: 'daily-quest.v3',
        p_retrieval: retrieval,
      })
      fail(error, 'persist no-quest plan')
    },

    async hasFinalizedPlanForDate(playerId, date) {
      const { count, error } = await client
        .from('quest_batches')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', playerId)
        .eq('quest_date', date)
        .eq('status', 'generated')
      fail(error, 'check finalized daily plan')
      return Number(count ?? 0) > 0
    },

    async hasNoQuestPlanForDate(playerId, date) {
      const { data, error } = await client
        .from('quest_batches')
        .select('generation_metadata')
        .eq('user_id', playerId)
        .eq('quest_date', date)
        .eq('status', 'generated')
        .maybeSingle()
      fail(error, 'check no-quest daily plan')
      return Boolean(asRecord(data?.generation_metadata).noQuest)
    },
  }
}
