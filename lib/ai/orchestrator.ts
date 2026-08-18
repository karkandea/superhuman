import type { AiProvider, ModelAudit } from './contracts'
import {
  materialityDisposition,
  validateMaterialityAssessment,
  validateQuestInterruptPlan,
  type MaterialityAssessmentDecision,
  type MaterialityContext,
  type PersistedMaterialityAssessment,
  type PersistedQuestInterrupt,
  type QuestInterruptPlan,
} from '../materiality'
import {
  UNDERSTANDING_TYPES,
  validateUnderstandingCandidates,
  type DerivedUnderstandingCandidate,
  type RetrievedPlayerContext,
} from '../player-understanding'
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

export interface MaterialityContextRetriever {
  retrieveForMateriality(input: {
    playerId: string
    knowledgeEntryId: string
    date: string
    limit: number
    now?: Date
  }): Promise<MaterialityContext>
  retrieveForSystemInterrupt(input: {
    playerId: string
    knowledgeEntryId: string
    date: string
    assessment: MaterialityAssessmentDecision
    limit: number
    now?: Date
  }): Promise<MaterialityContext>
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

export interface MaterialityRepository {
  findAssessment(input: {
    playerId: string
    knowledgeEntryId: string
    date: string
    version: string
  }): Promise<PersistedMaterialityAssessment | null>
  persistAssessment(input: {
    playerId: string
    knowledgeEntryId: string
    date: string
    decision: MaterialityAssessmentDecision
    audit: ModelAudit
    context: MaterialityContext
  }): Promise<PersistedMaterialityAssessment>
  findInterruptForAssessment(assessmentId: string): Promise<PersistedQuestInterrupt | null>
  persistInterrupt(input: {
    playerId: string
    date: string
    assessment: PersistedMaterialityAssessment
    plan: QuestInterruptPlan
    audit: ModelAudit
    context: MaterialityContext
    apply: boolean
  }): Promise<PersistedQuestInterrupt>
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

export interface MaterialityDependencies {
  provider: AiProvider
  contextRetriever: MaterialityContextRetriever
  repository: MaterialityRepository
}

const UNDERSTANDING_SCHEMA_VERSION = 'understanding.v1'
const QUEST_SCHEMA_VERSION = 'daily-quest.v1'
export const MATERIALITY_SCHEMA_VERSION = 'materiality.v1'
export const INTERRUPT_SCHEMA_VERSION = 'system-interrupt.v1'

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
    instructions: [
      'Extract only evidence-backed player understanding.',
      `Every candidate type must be exactly one of: ${UNDERSTANDING_TYPES.join(', ')}.`,
      'Do not invent new type labels or use topical labels such as career, health, finance, motivation, identity, or reflection as the type.',
      'Every candidate must cite sourceKnowledgeEntryIds from the retrieved context.',
      'Do not invent goals, obstacles, relationships, preferences, priorities, opportunities, constraints, or events that are not supported by the supplied evidence.',
    ].join(' '),
    context,
    responseContract: {
      type: 'array',
      required: ['type', 'summary', 'confidence', 'importance', 'sourceKnowledgeEntryIds'],
      items: {
        type: [...UNDERSTANDING_TYPES],
        summary: 'non-empty string',
        details: 'object optional',
        confidence: 'number 0..1',
        importance: 'integer 1..5',
        sourceKnowledgeEntryIds: 'non-empty array of ids from context.knowledgeEntries only',
        evidenceExcerpt: 'optional string',
      },
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
    instructions: [
      'Generate adaptive daily quests only from the retrieved player signals and context.',
      'Every quest must cite sourceSignalIds and explain its rationale. Never generate random filler tasks.',
      'Use only the canonical enum values provided in RESPONSE_CONTRACT for category, kind, and difficulty. Do not invent alternative labels.',
    ].join(' '),
    context,
    responseContract: {
      type: 'array',
      required: ['title', 'category', 'kind', 'difficulty', 'priority', 'xp', 'rationale', 'sourceSignalIds'],
      items: {
        title: 'non-empty string',
        category: ['pagi', 'siang', 'malam', 'sepanjang_hari'],
        kind: ['main', 'side', 'maintenance', 'bonus'],
        difficulty: ['easy', 'medium', 'hard'],
        priority: 'integer 1..5',
        xp: 'non-negative integer',
        rationale: 'non-empty string',
        sourceSignalIds: 'non-empty array of ids from context.signals only',
      },
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

export async function assessKnowledgeMateriality(
  dependencies: MaterialityDependencies,
  input: { playerId: string; knowledgeEntryId: string; date: string; limit?: number; now?: Date },
): Promise<{ source: 'existing' | 'assessed'; assessment: PersistedMaterialityAssessment }> {
  const provider = requireProvider(dependencies.provider)
  if (!input.playerId || !input.knowledgeEntryId) throw new Error('playerId and knowledgeEntryId are required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('date must use YYYY-MM-DD')

  const existing = await dependencies.repository.findAssessment({
    playerId: input.playerId,
    knowledgeEntryId: input.knowledgeEntryId,
    date: input.date,
    version: MATERIALITY_SCHEMA_VERSION,
  })
  if (existing) return { source: 'existing', assessment: existing }

  const context = await dependencies.contextRetriever.retrieveForMateriality({
    playerId: input.playerId,
    knowledgeEntryId: input.knowledgeEntryId,
    date: input.date,
    limit: input.limit ?? 24,
    now: input.now,
  })
  if (context.playerId !== input.playerId) throw new Error('Materiality context belongs to another player')

  const response = await provider.invokeStructured({
    operation: 'assess_materiality',
    schemaVersion: MATERIALITY_SCHEMA_VERSION,
    instructions: [
      'Decide whether this newly understood update is important AND time-sensitive enough to change today’s plan.',
      'Daily Quest is stable by default. Ordinary journaling, background context, mild mood changes, and long-term insights should usually be non-material.',
      'Material changes include same-day deadline/schedule shifts, emergencies, major health or relationship events, expiring opportunities, or facts that make an active quest unsafe or irrelevant.',
      'Use the supplied player timezone/localDateTime, current signals, recent quest results, and active quests. activeQuests may be empty when the existing plan is already completed; in that case an urgent update may still justify recommendedAction=add, but no completed/history quest may be targeted.',
      'sourceSignalIds should contain only signals that materially support the decision; it may be empty when the trigger update alone is sufficient.',
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
    new Set(context.activeQuests.map((quest) => quest.id)),
    new Set(context.signals.map((signal) => signal.id)),
  )

  const assessment = await dependencies.repository.persistAssessment({
    playerId: input.playerId,
    knowledgeEntryId: input.knowledgeEntryId,
    date: input.date,
    decision,
    audit: auditFrom(response, MATERIALITY_SCHEMA_VERSION),
    context,
  })
  return { source: 'assessed', assessment }
}

export async function generateSystemInterrupt(
  dependencies: MaterialityDependencies,
  input: { playerId: string; knowledgeEntryId: string; date: string; assessment: PersistedMaterialityAssessment; limit?: number; now?: Date },
): Promise<{ source: 'existing' | 'generated'; interrupt: PersistedQuestInterrupt }> {
  const provider = requireProvider(dependencies.provider)
  if (input.assessment.disposition === 'no_change') throw new Error('No-change materiality assessment cannot create an interrupt')

  const existing = await dependencies.repository.findInterruptForAssessment(input.assessment.id)
  if (existing) return { source: 'existing', interrupt: existing }

  const decision: MaterialityAssessmentDecision = {
    isMaterial: input.assessment.isMaterial,
    level: input.assessment.level,
    confidence: input.assessment.confidence,
    reason: input.assessment.reason,
    affectedQuestIds: input.assessment.affectedQuestIds,
    sourceSignalIds: input.assessment.sourceSignalIds,
    recommendedAction: input.assessment.recommendedAction,
    urgency: input.assessment.urgency,
  }
  if (materialityDisposition(decision) !== input.assessment.disposition) throw new Error('Persisted materiality disposition is inconsistent')

  const context = await dependencies.contextRetriever.retrieveForSystemInterrupt({
    playerId: input.playerId,
    knowledgeEntryId: input.knowledgeEntryId,
    date: input.date,
    assessment: decision,
    limit: input.limit ?? 24,
    now: input.now,
  })

  const response = await provider.invokeStructured({
    operation: 'generate_system_interrupt',
    schemaVersion: INTERRUPT_SCHEMA_VERSION,
    instructions: [
      'Create the smallest explicit revision needed because of the persisted material update. Do not regenerate the entire day.',
      'Supported actions are add, replace, defer, cancel, reprioritize. Prefer defer over cancel when the quest remains valid later.',
      'Never target completed or historical quests; only target ids present in activeQuests. If activeQuests is empty, the only valid mutation is add.',
      'For add/replace, create one evidence-backed quest and cite sourceSignalIds. For a priority shift, combine actions when needed (for example defer one quest + add interview preparation).',
      'Keep the plan concise and directly tied to the materiality reason.',
    ].join(' '),
    context,
    responseContract: {
      type: 'object',
      required: ['summary', 'actions'],
      actions: [{
        action: ['add', 'replace', 'defer', 'cancel', 'reprioritize'],
        targetQuestId: 'required except add',
        newPriority: 'required only for reprioritize',
        quest: 'required only for add/replace; fields title,category,kind,difficulty,priority,xp,rationale,sourceSignalIds',
        reason: 'required',
      }],
    },
  })

  const plan = validateQuestInterruptPlan(
    response.output,
    new Set(context.activeQuests.map((quest) => quest.id)),
    new Set(context.signals.map((signal) => signal.id)),
  )
  const interrupt = await dependencies.repository.persistInterrupt({
    playerId: input.playerId,
    date: input.date,
    assessment: input.assessment,
    plan,
    audit: auditFrom(response, INTERRUPT_SCHEMA_VERSION),
    context,
    apply: input.assessment.disposition === 'auto_interrupt',
  })

  return { source: 'generated', interrupt }
}
