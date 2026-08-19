import type { DailyContextSnapshot } from './daily-context'

export const UNDERSTANDING_TYPES = [
  'goal',
  'obstacle',
  'opportunity',
  'constraint',
  'preference',
  'relationship',
  'event',
  'priority',
] as const

export const UNDERSTANDING_DELTA_ACTIONS = ['create', 'update', 'resolve', 'supersede'] as const

export type UnderstandingType = (typeof UNDERSTANDING_TYPES)[number]
export type UnderstandingStatus = 'active' | 'resolved' | 'superseded' | 'archived'
export type UnderstandingRelation = 'origin' | 'supports' | 'contradicts' | 'updates'
export type UnderstandingDeltaActionType = (typeof UNDERSTANDING_DELTA_ACTIONS)[number]

export interface DerivedUnderstandingCandidate {
  type: UnderstandingType
  summary: string
  details: Record<string, unknown>
  confidence: number
  importance: number
  sourceKnowledgeEntryIds: string[]
  evidenceExcerpt?: string
}

export interface PersistedUnderstanding extends DerivedUnderstandingCandidate {
  id: string
  userId: string
  status: UnderstandingStatus
  firstObservedAt: string
  lastObservedAt: string
}

export interface PlayerSignal {
  id: string
  userId: string
  type: UnderstandingType | 'energy'
  summary: string
  importance: number
  confidence: number
  observedAt: string
  sourceUnderstandingId?: string
}

export interface RecentQuestResult {
  id: string
  questId: string
  outcome: 'completed' | 'partial' | 'skipped' | 'failed'
  note?: string
  recordedAt: string
  questTitle?: string
  questKind?: string
  questDifficulty?: string
  questDate?: string
}

export interface PlayerBriefUnderstandingItem {
  id: string
  type?: UnderstandingType
  summary: string
  details?: Record<string, unknown>
  confidence: number
  importance: number
  firstObservedAt?: string
  lastObservedAt: string
}

export interface PlayerBriefSignalItem {
  id: string
  type: UnderstandingType | 'energy'
  summary: string
  importance: number
  confidence: number
  observedAt: string
  sourceUnderstandingId?: string
}

export interface PlayerBriefSnapshot {
  id: string
  version: number
  schemaVersion: string
  reason: string
  createdAt: string
  generatedAt: string
  player: {
    id: string
    name: string
    timezone: string
  }
  activeUnderstandingIds: string[]
  highlights: PlayerBriefUnderstandingItem[]
  sections: {
    goals: PlayerBriefUnderstandingItem[]
    obstacles: PlayerBriefUnderstandingItem[]
    opportunities: PlayerBriefUnderstandingItem[]
    constraints: PlayerBriefUnderstandingItem[]
    preferences: PlayerBriefUnderstandingItem[]
    relationships: PlayerBriefUnderstandingItem[]
    events: PlayerBriefUnderstandingItem[]
    priorities: PlayerBriefUnderstandingItem[]
  }
  activeSignals: PlayerBriefSignalItem[]
  counts: {
    activeUnderstanding: number
    activeSignals: number
  }
}

export interface CurrentQuestContext {
  id: string
  title: string
  category: string
  kind: string
  difficulty: string
  priority: number
  xp: number
  rationale: string
  status: string
  source: string
  completedAt?: string
}

export interface UnderstandingDeltaAction {
  action: UnderstandingDeltaActionType
  targetUnderstandingId?: string
  type?: UnderstandingType
  summary?: string
  details?: Record<string, unknown>
  confidence?: number
  importance?: number
  sourceKnowledgeEntryIds: string[]
  evidenceExcerpt?: string
  reason: string
}

export interface PersistedUnderstandingDeltaResult {
  deltaBatchId: string
  actionCount: number
  playerBriefId: string
  playerBriefVersion: number
  playerBriefChanged: boolean
  source: 'persisted' | 'existing'
}

export interface RetrievedPlayerContext {
  playerId: string
  purpose: 'understanding' | 'daily_quest'
  generatedAt: string
  summary?: string
  playerBrief?: PlayerBriefSnapshot
  dailyContext?: DailyContextSnapshot | null
  knowledgeEntries: Array<{
    id: string
    type: string
    text: string
    occurredAt?: string
  }>
  signals: PlayerSignal[]
  recentQuestResults: RecentQuestResult[]
  activeQuests?: CurrentQuestContext[]
  retrieval: {
    strategy: string
    limit: number
    reason: string
    dailyContextId?: string
    dailyContextMode?: string
    questPolicyVersion?: string
    questPolicyDecision?: Record<string, unknown>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must contain at least one non-empty id`)
  }

  return [...new Set(value.map((item) => item.trim()))]
}

function validateCandidateFields(candidate: Record<string, unknown>, prefix: string): DerivedUnderstandingCandidate {
  if (!UNDERSTANDING_TYPES.includes(candidate.type as UnderstandingType)) {
    throw new Error(`${prefix} has unsupported type`)
  }

  const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : ''
  if (!summary) throw new Error(`${prefix} requires a summary`)

  const confidence = candidate.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`${prefix} confidence must be between 0 and 1`)
  }

  const importance = candidate.importance
  if (!Number.isInteger(importance) || Number(importance) < 1 || Number(importance) > 5) {
    throw new Error(`${prefix} importance must be an integer from 1 to 5`)
  }

  const details = candidate.details === undefined ? {} : candidate.details
  if (!isRecord(details)) throw new Error(`${prefix} details must be an object`)

  const evidenceExcerpt = candidate.evidenceExcerpt
  if (evidenceExcerpt !== undefined && typeof evidenceExcerpt !== 'string') {
    throw new Error(`${prefix} evidenceExcerpt must be a string`)
  }

  return {
    type: candidate.type as UnderstandingType,
    summary,
    details,
    confidence,
    importance: Number(importance),
    sourceKnowledgeEntryIds: assertStringArray(candidate.sourceKnowledgeEntryIds, `${prefix} sourceKnowledgeEntryIds`),
    ...(evidenceExcerpt?.trim() ? { evidenceExcerpt: evidenceExcerpt.trim() } : {}),
  }
}

export function validateUnderstandingCandidates(value: unknown): DerivedUnderstandingCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Understanding output must contain at least one candidate')
  }

  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Understanding candidate ${index} must be an object`)
    return validateCandidateFields(candidate, `Understanding candidate ${index}`)
  })
}

export function validateUnderstandingDelta(
  value: unknown,
  allowedKnowledgeIds: ReadonlySet<string>,
  allowedUnderstandingIds: ReadonlySet<string>,
): UnderstandingDeltaAction[] {
  if (!isRecord(value) || !Array.isArray(value.actions)) {
    throw new Error('Understanding delta output must be an object with an actions array')
  }

  const touched = new Set<string>()

  return value.actions.map((rawAction, index) => {
    if (!isRecord(rawAction)) throw new Error(`Understanding delta action ${index} must be an object`)
    if (!UNDERSTANDING_DELTA_ACTIONS.includes(rawAction.action as UnderstandingDeltaActionType)) {
      throw new Error(`Understanding delta action ${index} has unsupported action`)
    }

    const action = rawAction.action as UnderstandingDeltaActionType
    const reason = typeof rawAction.reason === 'string' ? rawAction.reason.trim() : ''
    if (!reason) throw new Error(`Understanding delta action ${index} requires a reason`)

    const sourceKnowledgeEntryIds = assertStringArray(
      rawAction.sourceKnowledgeEntryIds,
      `Understanding delta action ${index} sourceKnowledgeEntryIds`,
    )
    if (sourceKnowledgeEntryIds.some((id) => !allowedKnowledgeIds.has(id))) {
      throw new Error(`Understanding delta action ${index} references knowledge outside retrieved context`)
    }

    let targetUnderstandingId: string | undefined
    if (action !== 'create') {
      targetUnderstandingId = typeof rawAction.targetUnderstandingId === 'string'
        ? rawAction.targetUnderstandingId.trim()
        : ''
      if (!targetUnderstandingId || !allowedUnderstandingIds.has(targetUnderstandingId)) {
        throw new Error(`Understanding delta action ${index} references understanding outside current Player Brief`)
      }
      if (touched.has(targetUnderstandingId)) {
        throw new Error(`Understanding delta action ${index} mutates an understanding already targeted in this delta`)
      }
      touched.add(targetUnderstandingId)
    } else if (rawAction.targetUnderstandingId !== undefined) {
      throw new Error(`Understanding delta action ${index} create must not target an existing understanding`)
    }

    const evidenceExcerpt = rawAction.evidenceExcerpt
    if (evidenceExcerpt !== undefined && typeof evidenceExcerpt !== 'string') {
      throw new Error(`Understanding delta action ${index} evidenceExcerpt must be a string`)
    }

    if (action === 'resolve') {
      return {
        action,
        targetUnderstandingId,
        sourceKnowledgeEntryIds,
        reason,
        ...(evidenceExcerpt?.trim() ? { evidenceExcerpt: evidenceExcerpt.trim() } : {}),
      }
    }

    const candidate = validateCandidateFields(rawAction, `Understanding delta action ${index}`)
    return {
      action,
      ...(targetUnderstandingId ? { targetUnderstandingId } : {}),
      type: candidate.type,
      summary: candidate.summary,
      details: candidate.details,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sourceKnowledgeEntryIds,
      reason,
      ...(candidate.evidenceExcerpt ? { evidenceExcerpt: candidate.evidenceExcerpt } : {}),
    }
  })
}
