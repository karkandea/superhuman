import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider } from './ai/contracts'
import {
  materialityDisposition,
  validateMaterialityAssessment,
  type MaterialityContext,
  type PersistedMaterialityAssessment,
} from './materiality'
import { createSupabasePlayerContextStore } from './supabase/progression-store'

export const MATERIALITY_BATCH_SCHEMA_VERSION = 'materiality-batch.v1'

export interface PendingKnowledgeRow {
  id: string
  raw_text: string
}

export interface KnowledgeBudgetBatch {
  ids: string[]
  estimatedBytes: number
}

export interface BatchMaterialityAssessment extends PersistedMaterialityAssessment {
  knowledgeEntryIds: string[]
  batchKey: string
}

const encoder = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length
}

export function selectKnowledgeBatchByBytes(
  rows: PendingKnowledgeRow[],
  budgetBytes: number,
  perEntryOverheadBytes = 256,
): KnowledgeBudgetBatch {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) throw new Error('Knowledge batch budget must be positive')
  const ids: string[] = []
  let estimatedBytes = 0

  for (const row of rows) {
    const rowBytes = utf8ByteLength(row.raw_text || '') + perEntryOverheadBytes
    if (ids.length > 0 && estimatedBytes + rowBytes > budgetBytes) break
    ids.push(row.id)
    estimatedBytes += rowBytes
    if (estimatedBytes >= budgetBytes) break
  }

  return { ids, estimatedBytes }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8ByteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (utf8ByteLength(value.slice(0, mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  return value.slice(0, low)
}

function compactMaterialityKnowledge<T extends { id: string; type: string; text: string; occurredAt?: string }>(
  entries: T[],
  budgetBytes: number,
): { entries: T[]; truncatedCount: number } {
  if (entries.length === 0) return { entries: [], truncatedCount: 0 }
  const minimumPerEntry = 160
  const distributable = Math.max(0, budgetBytes - entries.length * minimumPerEntry)
  const fairShare = Math.max(256, Math.floor(distributable / entries.length) + minimumPerEntry)
  let remaining = budgetBytes
  let truncatedCount = 0

  const compacted = entries.map((entry, index) => {
    const remainingEntries = entries.length - index
    const allowance = Math.max(160, Math.min(fairShare, Math.floor(remaining / Math.max(1, remainingEntries))))
    const text = entry.text || ''
    const clipped = truncateUtf8(text, allowance)
    const wasTruncated = clipped.length < text.length
    if (wasTruncated) truncatedCount += 1
    const rendered = wasTruncated ? `${clipped}\n[truncated; derived signals remain available]` : clipped
    remaining = Math.max(0, remaining - utf8ByteLength(rendered))
    return { ...entry, text: rendered }
  })

  return { entries: compacted, truncatedCount }
}

function localDateTime(now: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  return formatter.format(now).replace(' ', 'T')
}

export function materialityBatchKey(date: string, knowledgeEntryIds: string[]): string {
  const stableIds = [...new Set(knowledgeEntryIds)].sort()
  const digest = createHash('sha256')
    .update(`${MATERIALITY_BATCH_SCHEMA_VERSION}\n${date}\n${stableIds.join('\n')}`)
    .digest('hex')
  return `${MATERIALITY_BATCH_SCHEMA_VERSION}:${digest}`
}

function mapAssessment(row: Record<string, unknown>): BatchMaterialityAssessment {
  const knowledgeEntryId = String(row.knowledge_entry_id)
  const knowledgeEntryIds = Array.isArray(row.knowledge_entry_ids)
    ? row.knowledge_entry_ids.map(String)
    : [knowledgeEntryId]
  return {
    id: String(row.id),
    userId: String(row.user_id),
    knowledgeEntryId,
    knowledgeEntryIds,
    batchKey: String(row.batch_key ?? ''),
    targetDate: String(row.target_date),
    isMaterial: Boolean(row.is_material),
    level: row.level as BatchMaterialityAssessment['level'],
    confidence: Number(row.confidence),
    reason: String(row.reason),
    affectedQuestIds: Array.isArray(row.affected_quest_ids) ? row.affected_quest_ids.map(String) : [],
    sourceSignalIds: Array.isArray(row.source_signal_ids) ? row.source_signal_ids.map(String) : [],
    recommendedAction: row.recommended_action as BatchMaterialityAssessment['recommendedAction'],
    urgency: row.urgency as BatchMaterialityAssessment['urgency'],
    disposition: row.disposition as BatchMaterialityAssessment['disposition'],
    createdAt: String(row.created_at),
  }
}

export async function assessActivityMateriality(
  dependencies: { client: SupabaseClient; provider: AiProvider },
  input: {
    playerId: string
    knowledgeEntryIds: string[]
    date: string
    signalLimit?: number
    rawKnowledgeBudgetBytes?: number
    now?: Date
  },
): Promise<{ source: 'existing' | 'assessed'; assessment: BatchMaterialityAssessment }> {
  const ids = [...new Set(input.knowledgeEntryIds)]
  if (!input.playerId || ids.length === 0) throw new Error('Activity materiality requires playerId and knowledgeEntryIds')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('date must use YYYY-MM-DD')

  const batchKey = materialityBatchKey(input.date, ids)
  const { data: existing, error: existingError } = await dependencies.client
    .from('materiality_assessments')
    .select('*')
    .eq('user_id', input.playerId)
    .eq('batch_key', batchKey)
    .maybeSingle()
  if (existingError) throw new Error(`find activity materiality: ${existingError.message}`)
  if (existing) return { source: 'existing', assessment: mapAssessment(existing as Record<string, unknown>) }

  const now = input.now ?? new Date()
  const store = createSupabasePlayerContextStore(dependencies.client)
  const signalLimit = input.signalLimit ?? 32
  const [rawKnowledge, signals, recentQuestResults, activeQuests, timezone, playerBrief] = await Promise.all([
    store.loadKnowledgeEntries(input.playerId, ids),
    store.loadSignals(input.playerId, signalLimit),
    store.loadRecentQuestResults(input.playerId, Math.min(10, signalLimit)),
    store.loadActiveQuests(input.playerId, input.date),
    store.loadPlayerTimezone(input.playerId),
    store.loadCurrentPlayerBrief(input.playerId),
  ])
  if (rawKnowledge.length !== ids.length) throw new Error('Activity materiality did not retrieve every trigger knowledge entry')
  if (!playerBrief) throw new Error('Canonical Player Brief is required for activity materiality')

  const compacted = compactMaterialityKnowledge(rawKnowledge, input.rawKnowledgeBudgetBytes ?? 24 * 1024)
  const triggerKnowledgeEntry = compacted.entries[0]
  if (!triggerKnowledgeEntry) throw new Error('Activity materiality trigger knowledge was not retrieved')

  const context: MaterialityContext & {
    triggerKnowledgeEntries: typeof compacted.entries
    knowledgeEntryIds: string[]
    batching: { knowledgeCount: number; rawKnowledgeBudgetBytes: number; truncatedKnowledgeCount: number }
  } = {
    playerId: input.playerId,
    purpose: 'materiality',
    generatedAt: now.toISOString(),
    targetDate: input.date,
    playerTimezone: timezone,
    localDateTime: localDateTime(now, timezone),
    playerBrief,
    triggerKnowledgeEntry,
    triggerKnowledgeEntries: compacted.entries,
    knowledgeEntryIds: ids,
    signals,
    recentQuestResults,
    activeQuests,
    batching: {
      knowledgeCount: ids.length,
      rawKnowledgeBudgetBytes: input.rawKnowledgeBudgetBytes ?? 24 * 1024,
      truncatedKnowledgeCount: compacted.truncatedCount,
    },
    retrieval: {
      strategy: 'canonical_player_brief_plus_activity_window_knowledge_signals_and_today_quests',
      limit: signalLimit,
      reason: 'Judge the combined effect of one activity window against canonical current player state and return one final decision for today',
    },
  }

  const response = await dependencies.provider.invokeStructured({
    operation: 'assess_materiality',
    schemaVersion: MATERIALITY_BATCH_SCHEMA_VERSION,
    instructions: [
      'Use playerBrief as the canonical current player state; conversation history is not memory.',
      'Treat all triggerKnowledgeEntries as one activity period, not as independent requests.',
      'Return exactly one final materiality decision for the combined effect of the entire activity period on today.',
      'Daily Quest is stable by default. Several low/medium updates do not become material merely because there are many of them.',
      'Prioritize conflicts, emergencies, same-day deadlines, meaningful schedule changes, safety/health changes, or facts that make an active quest irrelevant.',
      'Use the supplied player timezone/localDateTime, derived signals, recent quest results, and active quests.',
      'sourceSignalIds may only use ids from signals. affectedQuestIds may only use ids from activeQuests.',
      'If activeQuests is empty, urgent new context may recommend add, but completed/history quests must never be targeted.',
    ].join(' '),
    context,
    responseContract: {
      type: 'object',
      required: ['isMaterial', 'level', 'confidence', 'reason', 'affectedQuestIds', 'sourceSignalIds', 'recommendedAction', 'urgency'],
      isMaterial: 'boolean',
      level: ['low', 'medium', 'high', 'critical'],
      confidence: 'number 0..1',
      affectedQuestIds: 'array of ids from activeQuests only',
      sourceSignalIds: 'array of ids from signals only; may be empty',
      recommendedAction: ['none', 'add', 'replace', 'defer', 'cancel', 'reprioritize'],
      urgency: ['none', 'today', 'immediate'],
    },
  })

  const decision = validateMaterialityAssessment(
    response.output,
    new Set(activeQuests.map((quest) => quest.id)),
    new Set(signals.map((signal) => signal.id)),
  )
  const expectedDisposition = materialityDisposition(decision)

  const { data, error } = await dependencies.client.rpc('persist_materiality_batch_assessment', {
    p_user_id: input.playerId,
    p_knowledge_entry_ids: ids,
    p_batch_key: batchKey,
    p_target_date: input.date,
    p_assessment: decision,
    p_signal_ids: signals.map((signal) => signal.id),
    p_active_quest_ids: activeQuests.map((quest) => quest.id),
    p_provider_id: response.providerId,
    p_model_id: response.modelId,
    p_request_id: response.requestId ?? null,
    p_version: MATERIALITY_BATCH_SCHEMA_VERSION,
    p_generated_at: context.generatedAt,
    p_player_timezone: context.playerTimezone,
    p_local_datetime: context.localDateTime,
    p_retrieval: {
      ...context.retrieval,
      ...context.batching,
      playerBriefId: playerBrief.id,
      playerBriefVersion: playerBrief.version,
      playerBriefSchemaVersion: playerBrief.schemaVersion,
    },
  })
  if (error) throw new Error(`persist activity materiality: ${error.message}`)
  if (!data || typeof data !== 'object') throw new Error('persist activity materiality returned no assessment')

  const assessment = mapAssessment(data as Record<string, unknown>)
  if (assessment.disposition !== expectedDisposition) throw new Error('Persisted activity materiality disposition is inconsistent')
  return { source: 'assessed', assessment }
}
