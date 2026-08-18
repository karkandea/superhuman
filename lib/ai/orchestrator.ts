import type { AiProvider, ModelAudit } from './contracts'
import { validateUnderstandingCandidates, type DerivedUnderstandingCandidate, type RetrievedPlayerContext } from '../player-understanding'
import { validateGeneratedQuestCandidates, type GeneratedQuestCandidate, type PersistedDailyQuest } from '../quest-system'

export interface UnderstandingContextRetriever {
  retrieveForUnderstanding(input: {
    playerId: string
    knowledgeEntryIds: string[]
    limit: number
  }): Promise<RetrievedPlayerContext>
}

export interface DailyQuestContextRetriever {
  retrieveForDailyQuest(input: {
    playerId: string
    date: string
    limit: number
  }): Promise<RetrievedPlayerContext>
}

export interface UnderstandingRepository {
  persistDerived(input: {
    playerId: string
    candidates: DerivedUnderstandingCandidate[]
    audit: ModelAudit
    context: RetrievedPlayerContext
  }): Promise<void>
}

export interface DailyQuestRepository {
  findForDate(playerId: string, date: string): Promise<PersistedDailyQuest[]>
  persistGeneratedBatch(input: {
    playerId: string
    date: string
    candidates: GeneratedQuestCandidate[]
    audit: ModelAudit
    context: RetrievedPlayerContext
  }): Promise<PersistedDailyQuest[]>
}

export interface DeriveUnderstandingDependencies {
  provider: AiProvider
  contextRetriever: UnderstandingContextRetriever
  repository: UnderstandingRepository
}

export interface GenerateDailyQuestDependencies {
  provider: AiProvider
  contextRetriever: DailyQuestContextRetriever
  repository: DailyQuestRepository
}

const UNDERSTANDING_SCHEMA_VERSION = 'understanding.v1'
const QUEST_SCHEMA_VERSION = 'daily-quest.v1'

function requireProvider(provider: AiProvider | undefined): AiProvider {
  if (!provider || typeof provider.invokeStructured !== 'function') {
    throw new Error('AI provider is required; no fake or random fallback is allowed')
  }
  return provider
}

function auditFrom(providerResponse: {
  providerId: string
  modelId: string
  requestId?: string
}, schemaVersion: string): ModelAudit {
  return {
    providerId: providerResponse.providerId,
    modelId: providerResponse.modelId,
    requestId: providerResponse.requestId,
    schemaVersion,
  }
}

export async function derivePlayerUnderstanding(
  dependencies: DeriveUnderstandingDependencies,
  input: { playerId: string; knowledgeEntryIds: string[]; limit?: number },
): Promise<DerivedUnderstandingCandidate[]> {
  const provider = requireProvider(dependencies.provider)
  if (!input.playerId) throw new Error('playerId is required')
  if (input.knowledgeEntryIds.length === 0) throw new Error('At least one knowledge entry is required')

  const context = await dependencies.contextRetriever.retrieveForUnderstanding({
    playerId: input.playerId,
    knowledgeEntryIds: [...new Set(input.knowledgeEntryIds)],
    limit: input.limit ?? 24,
  })

  if (context.playerId !== input.playerId) throw new Error('Retrieved context belongs to another player')
  if (context.knowledgeEntries.length === 0) throw new Error('No player knowledge was retrieved')

  const response = await provider.invokeStructured({
    operation: 'derive_understanding',
    schemaVersion: UNDERSTANDING_SCHEMA_VERSION,
    instructions: 'Extract only evidence-backed player understanding. Every candidate must cite sourceKnowledgeEntryIds from the retrieved context. Do not invent goals, obstacles, relationships, preferences, or events.',
    context,
    responseContract: {
      type: 'array',
      required: ['type', 'summary', 'confidence', 'sourceKnowledgeEntryIds'],
    },
  })

  const candidates = validateUnderstandingCandidates(response.output)
  const allowedKnowledgeIds = new Set(context.knowledgeEntries.map((entry) => entry.id))

  for (const candidate of candidates) {
    if (candidate.sourceKnowledgeEntryIds.some((id) => !allowedKnowledgeIds.has(id))) {
      throw new Error('Understanding output references knowledge outside retrieved context')
    }
  }

  await dependencies.repository.persistDerived({
    playerId: input.playerId,
    candidates,
    audit: auditFrom(response, UNDERSTANDING_SCHEMA_VERSION),
    context,
  })

  return candidates
}

export async function generateDailyQuests(
  dependencies: GenerateDailyQuestDependencies,
  input: { playerId: string; date: string; limit?: number },
): Promise<{ source: 'existing' | 'generated'; quests: PersistedDailyQuest[] }> {
  const provider = requireProvider(dependencies.provider)
  if (!input.playerId) throw new Error('playerId is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('date must use YYYY-MM-DD')

  const existing = await dependencies.repository.findForDate(input.playerId, input.date)
  if (existing.length > 0) {
    return { source: 'existing', quests: existing }
  }

  const context = await dependencies.contextRetriever.retrieveForDailyQuest({
    playerId: input.playerId,
    date: input.date,
    limit: input.limit ?? 32,
  })

  if (context.playerId !== input.playerId) throw new Error('Retrieved context belongs to another player')
  if (context.signals.length === 0) {
    throw new Error('Daily quests require evidence-backed player signals; generation stopped')
  }

  const response = await provider.invokeStructured({
    operation: 'generate_daily_quests',
    schemaVersion: QUEST_SCHEMA_VERSION,
    instructions: 'Generate adaptive daily quests only from the retrieved player signals and context. Every quest must cite sourceSignalIds and explain its rationale. Never generate random filler tasks.',
    context,
    responseContract: {
      type: 'array',
      required: ['title', 'category', 'kind', 'difficulty', 'priority', 'xp', 'rationale', 'sourceSignalIds'],
    },
  })

  const allowedSignalIds = new Set(context.signals.map((signal) => signal.id))
  const candidates = validateGeneratedQuestCandidates(response.output, allowedSignalIds)

  const quests = await dependencies.repository.persistGeneratedBatch({
    playerId: input.playerId,
    date: input.date,
    candidates,
    audit: auditFrom(response, QUEST_SCHEMA_VERSION),
    context,
  })

  return { source: 'generated', quests }
}
