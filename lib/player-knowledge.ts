export const KNOWLEDGE_ENTRY_TYPES = [
  'life_update',
  'note',
  'journal',
  'goal',
  'relationship',
  'career',
  'wellness',
] as const

export type ManualKnowledgeEntryType = (typeof KNOWLEDGE_ENTRY_TYPES)[number]

export const KNOWLEDGE_SOURCE_TYPES = [
  ...KNOWLEDGE_ENTRY_TYPES,
  'document',
  'integration',
] as const

export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number]
export type KnowledgeProcessingStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'ignored'

export interface ManualKnowledgeInput {
  entryType: ManualKnowledgeEntryType
  text: string
  title?: string
  occurredAt?: string
  metadata?: Record<string, unknown>
}

export interface NormalizedManualKnowledge {
  entryType: ManualKnowledgeEntryType
  text: string
  title: string | null
  occurredAt: string | null
  metadata: Record<string, unknown>
}

export interface KnowledgeEntryRecord {
  id: string
  userId: string
  sourceId: string
  entryType: string
  rawText: string
  occurredAt: string | null
  processingStatus: KnowledgeProcessingStatus
  createdAt: string
}

const MAX_TEXT_LENGTH = 50_000
const MAX_TITLE_LENGTH = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeManualKnowledge(input: ManualKnowledgeInput): NormalizedManualKnowledge {
  if (!KNOWLEDGE_ENTRY_TYPES.includes(input.entryType)) {
    throw new Error(`Unsupported manual knowledge type: ${String(input.entryType)}`)
  }

  const text = input.text.trim()
  if (!text) throw new Error('Knowledge text cannot be empty')
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`Knowledge text exceeds ${MAX_TEXT_LENGTH} characters`)

  const title = input.title?.trim() || null
  if (title && title.length > MAX_TITLE_LENGTH) {
    throw new Error(`Knowledge title exceeds ${MAX_TITLE_LENGTH} characters`)
  }

  if (input.metadata !== undefined && !isRecord(input.metadata)) {
    throw new Error('Knowledge metadata must be an object')
  }

  if (input.occurredAt && Number.isNaN(Date.parse(input.occurredAt))) {
    throw new Error('occurredAt must be a valid timestamp')
  }

  return {
    entryType: input.entryType,
    text,
    title,
    occurredAt: input.occurredAt ?? null,
    metadata: input.metadata ?? {},
  }
}
