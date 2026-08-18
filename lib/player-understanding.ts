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

export type UnderstandingType = (typeof UNDERSTANDING_TYPES)[number]
export type UnderstandingStatus = 'active' | 'resolved' | 'superseded' | 'archived'
export type UnderstandingRelation = 'origin' | 'supports' | 'contradicts' | 'updates'

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
  questId: string
  outcome: 'completed' | 'partial' | 'skipped' | 'failed'
  note?: string
  recordedAt: string
}

export interface RetrievedPlayerContext {
  playerId: string
  purpose: 'understanding' | 'daily_quest'
  generatedAt: string
  summary?: string
  knowledgeEntries: Array<{
    id: string
    type: string
    text: string
    occurredAt?: string
  }>
  signals: PlayerSignal[]
  recentQuestResults: RecentQuestResult[]
  retrieval: {
    strategy: string
    limit: number
    reason: string
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

export function validateUnderstandingCandidates(value: unknown): DerivedUnderstandingCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Understanding output must contain at least one candidate')
  }

  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Understanding candidate ${index} must be an object`)
    if (!UNDERSTANDING_TYPES.includes(candidate.type as UnderstandingType)) {
      throw new Error(`Understanding candidate ${index} has unsupported type`)
    }

    const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : ''
    if (!summary) throw new Error(`Understanding candidate ${index} requires a summary`)

    const confidence = candidate.confidence
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`Understanding candidate ${index} confidence must be between 0 and 1`)
    }

    const importance = candidate.importance
    if (!Number.isInteger(importance) || Number(importance) < 1 || Number(importance) > 5) {
      throw new Error(`Understanding candidate ${index} importance must be an integer from 1 to 5`)
    }

    const details = candidate.details === undefined ? {} : candidate.details
    if (!isRecord(details)) throw new Error(`Understanding candidate ${index} details must be an object`)

    const evidenceExcerpt = candidate.evidenceExcerpt
    if (evidenceExcerpt !== undefined && typeof evidenceExcerpt !== 'string') {
      throw new Error(`Understanding candidate ${index} evidenceExcerpt must be a string`)
    }

    return {
      type: candidate.type as UnderstandingType,
      summary,
      details,
      confidence,
      importance: Number(importance),
      sourceKnowledgeEntryIds: assertStringArray(candidate.sourceKnowledgeEntryIds, `candidate ${index} sourceKnowledgeEntryIds`),
      ...(evidenceExcerpt?.trim() ? { evidenceExcerpt: evidenceExcerpt.trim() } : {}),
    }
  })
}
