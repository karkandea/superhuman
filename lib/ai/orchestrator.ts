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
  validateUnderstandingDelta,
  type DerivedUnderstandingCandidate,
  type PersistedUnderstandingDeltaResult,
  type RetrievedPlayerContext,
  type UnderstandingDeltaAction,
} from '../player-understanding'
import {
  QUEST_POLICY_VERSION,
  compactQuestPolicyDecision,
  questPolicyInstructions,
  validateQuestPolicyDecision,
} from '../quest-policy'
import type { GeneratedQuestCandidate, PersistedDailyQuest } from '../quest-system'

export interface UnderstandingContextRetriever {
  retrieveForUnderstanding(input: {
    playerId: string
    knowledgeEntryIds: string[]
    limit: number
  }): Promise<RetrievedPlayerContext>
}

export interface UnderstandingDeltaContextRetriever extends UnderstandingContextRetriever {
  retrieveForUnderstandingDelta(input: {
    playerId: string
    knowledgeEntryIds: string[]
    date: string
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
  persistDelta(input: {
    playerId: string
    actions: UnderstandingDeltaAction[]
    batchKey: string
    audit: ModelAudit
    context: RetrievedPlayerContext
  }): Promise<PersistedUnderstandingDeltaResult>
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

export interface DeriveUnderstandingDeltaDependencies {
  provider: AiProvider
  contextRetriever: UnderstandingDeltaContextRetriever
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
export const UNDERSTANDING_DELTA_SCHEMA_VERSION = 'understanding-delta.v1'
const QUEST_SCHEMA_VERSION = 'daily-quest.v2'
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

// Legacy extraction remains for compatibility with historical jobs/tests. Production progression
// uses derivePlayerUnderstandingDelta so canonical memory evolves instead of accumulating duplicates.
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

export async function derivePlayerUnderstandingDelta(
  dependencies: DeriveUnderstandingDeltaDependencies,
  input: { playerId: string; knowledgeEntryIds: string[]; date: string; batchKey: string; limit?: number },
): Promise<{ actions: UnderstandingDeltaAction[]; persistence: PersistedUnderstandingDeltaResult }> {
  const provider = requireProvider(dependencies.provider)
  if (!input.playerId) throw new Error('playerId is required')
  if (input.knowledgeEntryIds.length === 0) throw new Error('At least one knowledge entry is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('date must use YYYY-MM-DD')
  if (!input.batchKey.trim()) throw new Error('batchKey is required')

  const context = await dependencies.contextRetriever.retrieveForUnderstandingDelta({
    playerId: input.playerId,
    knowledgeEntryIds: [...new Set(input.knowledgeEntryIds)],
    date: input.date,
    limit: input.limit ?? 24,
  })

  if (context.playerId !== input.playerId) throw new Error('Retrieved context belongs to another player')
  if (context.knowledgeEntries.length === 0) throw new Error('No player knowledge was retrieved')
  if (!context.playerBrief) throw new Error('Canonical Player Brief is required for understanding delta')

  const response = await provider.invokeStructured({
    operation: 'derive_understanding_delta',
    schemaVersion: UNDERSTANDING_DELTA_SCHEMA_VERSION,
    instructions: [
      'Treat playerBrief as the canonical current state of this player. Do not reconstruct identity from scratch and do not treat conversation history as memory.',
      'Compare only the new knowledgeEntries against playerBrief, active signals, recent quest results, and active quests, then return the smallest evidence-backed state delta.',
      'Valid actions are create, update, resolve, supersede. Return actions: [] when the new batch does not materially change persistent player understanding.',
      'Use create only for genuinely new persistent understanding. Use update when an existing understanding is still the same concept but has evolved. Use resolve when an active understanding is no longer true/relevant. Use supersede when new evidence replaces or contradicts an active understanding.',
      `For create/update/supersede, type must be exactly one of: ${UNDERSTANDING_TYPES.join(', ')}.`,
      'targetUnderstandingId may only reference playerBrief.activeUnderstandingIds. create must not target an existing understanding.',
      'Every action must cite sourceKnowledgeEntryIds from knowledgeEntries only and include a concise reason. Never infer a state change without evidence from the new activity batch.',
      'Do not create duplicate understanding just because wording differs. Prefer no-op or update when the current Player Brief already represents the same fact.',
    ].join(' '),
    context,
    responseContract: {
      type: 'object',
      required: ['actions'],
      actions: [{
        action: ['create', 'update', 'resolve', 'supersede'],
        targetUnderstandingId: 'required for update/resolve/supersede; id from playerBrief.activeUnderstandingIds only; forbidden for create',
        type: [...UNDERSTANDING_TYPES, 'required for create/update/supersede; omit for resolve'],
        summary: 'non-empty string required for create/update/supersede; omit for resolve',
        details: 'object required for create/update/supersede; omit for resolve',
        confidence: 'number 0..1 required for create/update/supersede; omit for resolve',
        importance: 'integer 1..5 required for create/update/supersede; omit for resolve',
        sourceKnowledgeEntryIds: 'non-empty array of ids from context.knowledgeEntries only',
        evidenceExcerpt: 'optional string copied or tightly paraphrased from source evidence',
        reason: 'non-empty concise reason for this state transition',
      }],
    },
  })

  const actions = validateUnderstandingDelta(
    response.output,
    new Set(context.knowledgeEntries.map((entry) => entry.id)),
    new Set(context.playerBrief.activeUnderstandingIds),
  )

  const persistence = await dependencies.repository.persistDelta({
    playerId: input.playerId,
    actions,
    batchKey: input.batchKey,
    audit: auditFrom(response, UNDERSTANDING_DELTA_SCHEMA_VERSION),
    context,
  })

  return { actions, persistence }
}

export async function generateDailyQuests(
  dependencies: GenerateDailyQuestDependencies,
  input: { playerId: string; date: string; limit?: number },
): Promise<{ source: 'existing' | 'generated' | 'awaiting_context'; quests: PersistedDailyQuest[] }> {
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
  if (!context.playerBrief) throw new Error('Canonical Player Brief is required for Daily Quest generation')
  if (!context.dailyContext) {
    return { source: 'awaiting_context', quests: [] }
  }
  if (context.dailyContext.contextDate !== input.date) {
    throw new Error('Daily Context belongs to a different date')
  }
  if (context.signals.length === 0) {
    throw new Error('Daily quests require evidence-backed player signals; generation stopped')
  }

  const provider = requireProvider(dependencies.provider)
  const response = await provider.invokeStructured({
    operation: 'generate_daily_quests',
    schemaVersion: QUEST_SCHEMA_VERSION,
    instructions: [
      'Use playerBrief as the canonical permanent/current player state; conversation history is not memory.',
      'Use dailyContext only as temporary state for this target date. Never convert one-off Daily Context into permanent identity, routine, or long-term player understanding.',
      'Use recentQuestResults, including quest titles/difficulty when supplied, as calibration evidence for repetition, bottlenecks, and appropriate challenge.',
      'Every candidate must cite sourceSignalIds and explain its rationale. Never generate random filler tasks or a checklist that merely mirrors every active goal.',
      'Use only the canonical enum values provided in RESPONSE_CONTRACT for category, kind, and difficulty. Do not invent alternative labels.',
      questPolicyInstructions(),
    ].join(' '),
    context,
    responseContract: {
      type: 'object',
      required: ['candidates', 'selections'],
      candidates: [{
        candidateId: 'unique short non-empty string',
        title: 'non-empty action the player can execute today',
        category: ['pagi', 'siang', 'malam', 'sepanjang_hari'],
        difficulty: ['easy', 'medium', 'hard'],
        xp: 'non-negative integer',
        rationale: 'concise evidence-backed reason this action could matter today',
        sourceSignalIds: 'non-empty array of ids from context.signals only',
        scores: {
          goalRelevance: 'integer 0..5',
          urgency: 'integer 0..5',
          leverage: 'integer 0..5',
          obstacleRemoval: 'integer 0..5',
          actionability: 'integer 0..5',
          contextFit: 'integer 0..5',
          progressionValue: 'integer 0..5',
          redundancyPenalty: 'integer 0..5; higher means more repetitive/less useful',
        },
      }],
      selections: [{
        candidateId: 'id from candidates only',
        kind: ['main', 'side', 'maintenance', 'bonus'],
        priority: 'integer 1..5; 5 is highest',
        selectionReason: 'concise explanation for why this candidate belongs in today portfolio',
      }],
    },
  })

  const decision = validateQuestPolicyDecision(
    response.output,
    new Set(context.signals.map((signal) => signal.id)),
  )

  const persistenceContext: RetrievedPlayerContext = {
    ...context,
    retrieval: {
      ...context.retrieval,
      questPolicyVersion: QUEST_POLICY_VERSION,
      questPolicyDecision: compactQuestPolicyDecision(decision),
    },
  }

  const quests = await dependencies.repository.persistGeneratedBatch({
    playerId: input.playerId,
    date: input.date,
    candidates: decision.quests,
    audit: auditFrom(response, QUEST_SCHEMA_VERSION),
    context: persistenceContext,
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
  if (!context.playerBrief) throw new Error('Canonical Player Brief is required for materiality assessment')

  const response = await provider.invokeStructured({
    operation: 'assess_materiality',
    schemaVersion: MATERIALITY_SCHEMA_VERSION,
    instructions: [
      'Use playerBrief as the canonical current player state; conversation history is not memory.',
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
  if (!context.playerBrief) throw new Error('Canonical Player Brief is required for System Interrupt generation')

  const response = await provider.invokeStructured({
    operation: 'generate_system_interrupt',
    schemaVersion: INTERRUPT_SCHEMA_VERSION,
    instructions: [
      'Use playerBrief as the canonical current player state; conversation history is not memory.',
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
