import type { AiProvider, ModelAudit } from './contracts'
import {
  derivePlayerUnderstandingDelta as deriveCoreUnderstandingDelta,
  type DeriveUnderstandingDeltaDependencies,
} from './orchestrator-core'
import {
  UNDERSTANDING_TYPES,
  validateUnderstandingDelta,
  type PersistedUnderstandingDeltaResult,
  type UnderstandingDeltaAction,
} from '../player-understanding'
import {
  INITIALIZATION_DIMENSIONS,
  validateInitializationCalibrationDecision,
} from '../player-initialization'
import {
  loadInitializationRuntimeContext,
  persistInitializationRuntimeDecision,
} from './player-initialization-runtime'

export const PLAYER_INITIALIZATION_CALIBRATION_SCHEMA_VERSION = 'player-initialization-calibration.v1'

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
}): ModelAudit {
  return {
    providerId: providerResponse.providerId,
    modelId: providerResponse.modelId,
    requestId: providerResponse.requestId,
    schemaVersion: PLAYER_INITIALIZATION_CALIBRATION_SCHEMA_VERSION,
  }
}

export async function derivePlayerUnderstandingDelta(
  dependencies: DeriveUnderstandingDeltaDependencies,
  input: { playerId: string; knowledgeEntryIds: string[]; date: string; batchKey: string; limit?: number },
): Promise<{ actions: UnderstandingDeltaAction[]; persistence: PersistedUnderstandingDeltaResult }> {
  const initialization = await loadInitializationRuntimeContext(input.playerId, input.knowledgeEntryIds)
  if (!initialization) {
    return deriveCoreUnderstandingDelta(dependencies, input)
  }

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
  if (!context.playerBrief) throw new Error('Canonical Player Brief is required for initialization calibration')

  const response = await provider.invokeStructured({
    operation: 'calibrate_player_initialization',
    schemaVersion: PLAYER_INITIALIZATION_CALIBRATION_SCHEMA_VERSION,
    instructions: [
      'This is Player Initialization / Decision Readiness, not Daily Quest generation. Never generate quests or candidate actions here.',
      'Treat playerBrief as canonical current persistent state. Compare the supplied new knowledgeEntries against it and return the smallest evidence-backed understanding delta.',
      'Use only supplied player answers, Life Vault evidence, playerBrief, signals, quest history, and active quests as facts about this player.',
      'Do not infer a goal from occupation, demographics, hobbies, or domain stereotypes. A software engineer does not imply a goal to work abroad. A runner does not imply a marathon goal.',
      'Web research is not default onboarding. Never search for the player identity or personal facts. General domain knowledge/research may be used only to understand a domain the player explicitly introduced and only when it materially improves question quality.',
      'Decide readiness across exactly four dimensions: direction, current_state, bottleneck_opportunity, capacity_constraints.',
      'READY means there is reasonably enough evidence to make a meaningful progression decision. It does not require knowing the player entire life.',
      'ASK when critical information is missing, contradictory, or too uncertain for a meaningful progression decision. Low confidence is a valid reason to ASK.',
      'ASK questions must be non-leading, concise, evidence-based, and only reduce uncertainty that blocks progression. Do not ask random profile-completion questions.',
      'Propose at most five candidate follow-up questions in one batch and prefer fewer. The System, not the AI, controls which one is shown next.',
      'Questions should target missing or uncertain readiness dimensions. Do not repeat information already established by playerBrief or answered initialization questions.',
      'Valid persistent understanding actions are create, update, resolve, supersede. Return actions: [] when the batch does not materially change persistent understanding.',
      'Use update/supersede/resolve for contradictory or changed knowledge instead of keeping two incompatible truths. Temporary evidence must not become permanent identity.',
      `For create/update/supersede, understanding type must be exactly one of: ${UNDERSTANDING_TYPES.join(', ')}.`,
      'targetUnderstandingId may only reference playerBrief.activeUnderstandingIds. Every understanding action must cite sourceKnowledgeEntryIds from knowledgeEntries only.',
    ].join(' '),
    context: {
      ...context,
      initialization,
    },
    responseContract: {
      type: 'object',
      required: ['actions', 'readiness', 'reason', 'dimensions', 'questions'],
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
      readiness: ['ask', 'ready'],
      reason: 'concise internal explanation of why the System is ASK or READY',
      dimensions: Object.fromEntries(INITIALIZATION_DIMENSIONS.map(key => [key, {
        status: ['missing', 'uncertain', 'sufficient'],
        confidence: 'number 0..1',
        summary: `concise evidence-based assessment of ${key}`,
      }])),
      questions: [{
        questionKey: 'short stable semantic key unique in this batch',
        dimension: [...INITIALIZATION_DIMENSIONS],
        prompt: 'one concise non-leading question shown directly to the player',
        reason: 'internal explanation of which decision uncertainty this removes',
        priority: 'integer 1..5',
        sequence: 'integer 0..100; lower renders earlier when priorities tie',
      }],
    },
  })

  const raw = response.output as Record<string, unknown>
  const actions = validateUnderstandingDelta(
    { actions: raw.actions },
    new Set(context.knowledgeEntries.map(entry => entry.id)),
    new Set(context.playerBrief.activeUnderstandingIds),
  )
  const decision = validateInitializationCalibrationDecision({
    readiness: raw.readiness,
    reason: raw.reason,
    dimensions: raw.dimensions,
    questions: raw.questions,
  })
  const audit = auditFrom(response)

  const persistence = await dependencies.repository.persistDelta({
    playerId: input.playerId,
    actions,
    batchKey: input.batchKey,
    audit,
    context,
  })

  await persistInitializationRuntimeDecision(input.playerId, decision, audit)

  return { actions, persistence }
}
