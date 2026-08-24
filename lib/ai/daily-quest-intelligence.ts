import type { AiProvider, AiProviderResponse, ModelAudit, QuestOutputRepairContext } from './contracts'
import type { DailyQuestContextRetriever, DailyQuestRepository } from './orchestrator'
import { loadQuestGenerationIntelligence } from './progression-intelligence'
import {
  QUEST_INTELLIGENCE_POLICY_VERSION,
  compactQuestIntelligenceDecision,
  questIntelligencePolicyInstructions,
  questPolicyValidatorCode,
  validateQuestIntelligenceDecision,
} from '../quest-intelligence-policy'
import type { ProgressionIntelligenceContext } from '../progression-intelligence'
import type { RetrievedPlayerContext } from '../player-understanding'
import type { PersistedDailyQuest } from '../quest-system'
import type { ProgressionIntelligenceStore } from '../supabase/progression-intelligence-store'

export const DAILY_QUEST_INTELLIGENCE_SCHEMA_VERSION = 'daily-quest.v4'

export interface DailyQuestGenerationResult {
  source: 'existing' | 'generated' | 'awaiting_context' | 'no_quest'
  quests: PersistedDailyQuest[]
  noQuestReason?: string
  repairAttemptCount?: number
  validatorCode?: string
  requestId?: string
}

export interface QuestRepairTelemetry {
  onStart?(input: { validatorCode: string }): Promise<void> | void
  onComplete?(input: {
    status: 'succeeded' | 'failed'
    validatorCode: string
    requestId?: string
    errorMessage?: string
  }): Promise<void> | void
}

function requireProvider(provider: AiProvider | undefined): AiProvider {
  if (!provider || typeof provider.invokeStructured !== 'function') {
    throw new Error('AI provider is required; no fake or random fallback is allowed')
  }
  return provider
}

function auditFrom(response: { providerId: string; modelId: string; requestId?: string }): ModelAudit {
  return {
    providerId: response.providerId,
    modelId: response.modelId,
    requestId: response.requestId,
    schemaVersion: DAILY_QUEST_INTELLIGENCE_SCHEMA_VERSION,
  }
}

function questKey(quest: { title: string; kind: string; priority: number }) {
  return `${quest.title}\u0000${quest.kind}\u0000${quest.priority}`
}

function questResponseContract() {
  return {
    type: 'object',
    required: ['candidates', 'selections'],
    candidates: [{
      candidateId: 'unique short non-empty string',
      title: 'concise executable action',
      category: ['pagi', 'siang', 'malam', 'sepanjang_hari'],
      difficulty: ['easy', 'medium', 'hard'],
      sourceSignalIds: 'non-empty ids from context.signals only',
      strategicChain: {
        goalId: 'goal id from progressionMap; required except pure maintenance',
        proximalOutcomeId: 'proximal outcome id from progressionMap; required except pure maintenance',
        driverType: ['bottleneck', 'opportunity', 'maintenance'],
        driverId: 'matching bottleneck/opportunity id; omit for maintenance',
        causalReason: 'why this action should move the driver/outcome',
      },
      feasibility: {
        feasibleToday: 'boolean',
        receptivity: ['low', 'medium', 'high', 'unknown'],
        estimatedMinutes: 'integer 1..480',
        reason: 'why it fits or does not fit today',
      },
      executionContract: {
        action: 'specific behavior',
        completionCondition: 'observable definition of done',
        appropriateContext: 'when/where/context that makes execution realistic',
        dose: 'bounded amount such as 1 role, 20 minutes, 2 messages',
      },
    }],
    selections: [{
      candidateId: 'id from candidates only',
      kind: ['main', 'side', 'maintenance', 'bonus'],
      selectionReason: 'why it belongs in this portfolio; order selections most important to least important',
    }],
    noQuestReason: 'required only when selections is empty',
  }
}

function boundedValidatorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500)
}

async function runTelemetry(callback: (() => Promise<void> | void) | undefined) {
  if (!callback) return
  try {
    await callback()
  } catch {
    // Telemetry must never change the AI decision or persistence outcome.
  }
}

async function validateWithSingleRepair(input: {
  provider: AiProvider
  initialResponse: AiProviderResponse
  providerContext: ProgressionIntelligenceContext
  allowedSignalIds: ReadonlySet<string>
  progressionMap: NonNullable<ProgressionIntelligenceContext['progressionMap']>
  progressionTarget: NonNullable<Awaited<ReturnType<ProgressionIntelligenceStore['loadProgressionTargetForDate']>>>
  repairTelemetry?: QuestRepairTelemetry
}) {
  try {
    return {
      response: input.initialResponse,
      decision: validateQuestIntelligenceDecision(
        input.initialResponse.output,
        input.allowedSignalIds,
        { progressionMap: input.progressionMap, progressionTarget: input.progressionTarget },
      ),
      repairAttemptCount: 0,
      validatorCode: undefined as string | undefined,
      initialValidatorCode: undefined as string | undefined,
    }
  } catch (initialError) {
    const initialValidatorCode = questPolicyValidatorCode(initialError)
    const repairContext: QuestOutputRepairContext = {
      ...input.providerContext,
      questRepair: {
        validatorCode: initialValidatorCode,
        validatorMessage: boundedValidatorMessage(initialError),
        previousOutput: input.initialResponse.output,
      },
    }

    await runTelemetry(input.repairTelemetry?.onStart
      ? () => input.repairTelemetry!.onStart!({ validatorCode: initialValidatorCode })
      : undefined)

    let repairResponse: AiProviderResponse
    try {
      repairResponse = await input.provider.invokeStructured({
        operation: 'repair_daily_quest_output',
        schemaVersion: DAILY_QUEST_INTELLIGENCE_SCHEMA_VERSION,
        instructions: [
          'Repair one rejected Daily Quest draft. This is a targeted schema/business-constraint repair, not a new strategic decision.',
          'The Progression Target is already final. Preserve its intent and preserve valid candidate meaning from the previous draft whenever possible.',
          'Fix only what is required by questRepair.validatorCode / validatorMessage and the RESPONSE_CONTRACT.',
          'Return the complete corrected payload, not a patch.',
          'Do not create new goals, bottlenecks, opportunities, source ids, or player facts.',
          'Do not output XP, priority, rationale duplicates, or score grids; the System owns those mechanics.',
          questIntelligencePolicyInstructions(),
        ].join(' '),
        context: repairContext,
        responseContract: questResponseContract(),
      })
    } catch (repairInvokeError) {
      await runTelemetry(input.repairTelemetry?.onComplete
        ? () => input.repairTelemetry!.onComplete!({
          status: 'failed',
          validatorCode: initialValidatorCode,
          errorMessage: boundedValidatorMessage(repairInvokeError),
        })
        : undefined)
      if (repairInvokeError && typeof repairInvokeError === 'object') {
        Object.assign(repairInvokeError, { repairAttemptCount: 1, initialValidatorCode })
      }
      throw repairInvokeError
    }

    try {
      const decision = validateQuestIntelligenceDecision(
        repairResponse.output,
        input.allowedSignalIds,
        { progressionMap: input.progressionMap, progressionTarget: input.progressionTarget },
      )
      await runTelemetry(input.repairTelemetry?.onComplete
        ? () => input.repairTelemetry!.onComplete!({
          status: 'succeeded',
          validatorCode: initialValidatorCode,
          requestId: repairResponse.requestId,
        })
        : undefined)
      return {
        response: repairResponse,
        decision,
        repairAttemptCount: 1,
        validatorCode: undefined as string | undefined,
        initialValidatorCode,
      }
    } catch (repairError) {
      const validatorCode = questPolicyValidatorCode(repairError)
      await runTelemetry(input.repairTelemetry?.onComplete
        ? () => input.repairTelemetry!.onComplete!({
          status: 'failed',
          validatorCode,
          requestId: repairResponse.requestId,
          errorMessage: boundedValidatorMessage(repairError),
        })
        : undefined)
      throw Object.assign(
        new Error(`Quest Policy repair failed [${validatorCode}]: ${boundedValidatorMessage(repairError)}`),
        {
          validatorCode,
          initialValidatorCode,
          repairAttemptCount: 1,
          initialRequestId: input.initialResponse.requestId,
          repairRequestId: repairResponse.requestId,
        },
      )
    }
  }
}

export async function generateDailyQuestsWithIntelligence(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    repository: DailyQuestRepository
    progressionStore: ProgressionIntelligenceStore
    repairTelemetry?: QuestRepairTelemetry
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<DailyQuestGenerationResult> {
  if (!input.playerId) throw new Error('playerId is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('date must use YYYY-MM-DD')

  const existing = await dependencies.repository.findForDate(input.playerId, input.date)
  if (existing.length > 0) return { source: 'existing', quests: existing, repairAttemptCount: 0 }
  if (await dependencies.progressionStore.hasNoQuestPlanForDate(input.playerId, input.date)) {
    const target = await dependencies.progressionStore.loadProgressionTargetForDate(input.playerId, input.date)
    return { source: 'no_quest', quests: [], repairAttemptCount: 0, ...(target?.noQuestReason ? { noQuestReason: target.noQuestReason } : {}) }
  }

  const context = await dependencies.contextRetriever.retrieveForDailyQuest({
    playerId: input.playerId,
    date: input.date,
    limit: input.limit ?? 32,
  })
  if (context.playerId !== input.playerId) throw new Error('Retrieved context belongs to another player')
  if (!context.playerBrief) throw new Error('Canonical Player Brief is required for Daily Quest generation')
  if (!context.dailyContext) return { source: 'awaiting_context', quests: [], repairAttemptCount: 0 }
  if (context.dailyContext.contextDate !== input.date) throw new Error('Daily Context belongs to a different date')

  const intelligence = await loadQuestGenerationIntelligence(dependencies.progressionStore, input)
  if (!intelligence.progressionMap) throw new Error('Progression Map is required before Daily Quest generation')
  if (!intelligence.progressionTarget) throw new Error('Progression Target is required before Daily Quest generation')

  const retrievalBase = {
    ...context.retrieval,
    progressionMapId: intelligence.progressionMap.id,
    progressionMapVersion: intelligence.progressionMap.version,
    playerResponseModelId: intelligence.playerResponseModel?.id ?? null,
    playerResponseModelVersion: intelligence.playerResponseModel?.version ?? null,
    progressionTargetId: intelligence.progressionTarget.id,
    progressionTarget: intelligence.progressionTarget,
  }

  if (intelligence.progressionTarget.mode === 'no_intervention') {
    const noQuestReason = intelligence.progressionTarget.noQuestReason ?? intelligence.progressionTarget.rationale
    await dependencies.progressionStore.persistNoQuestPlan({
      playerId: input.playerId,
      date: input.date,
      progressionTargetId: intelligence.progressionTarget.id,
      noQuestReason,
      audit: {
        providerId: 'system-policy',
        modelId: 'no-intervention',
        schemaVersion: DAILY_QUEST_INTELLIGENCE_SCHEMA_VERSION,
      },
      retrieval: {
        ...retrievalBase,
        questPolicyVersion: QUEST_INTELLIGENCE_POLICY_VERSION,
        noQuestReason,
      },
    })
    return { source: 'no_quest', quests: [], noQuestReason, repairAttemptCount: 0 }
  }

  if (context.signals.length === 0) throw new Error('Daily quests require evidence-backed player signals; generation stopped')
  const [questResponses, progressionMapSnapshot, playerResponseModelSnapshot] = await Promise.all([
    dependencies.progressionStore.loadQuestResponseEvents(input.playerId, 24),
    dependencies.progressionStore.loadCurrentProgressionMap(input.playerId),
    dependencies.progressionStore.loadCurrentPlayerResponseModel(input.playerId),
  ])
  if (!progressionMapSnapshot || progressionMapSnapshot.id !== intelligence.progressionMap.id) {
    throw new Error('Progression Map changed before Daily Quest reasoning')
  }
  if (intelligence.playerResponseModel && playerResponseModelSnapshot?.id !== intelligence.playerResponseModel.id) {
    throw new Error('Player Response Model changed before Daily Quest reasoning')
  }

  const providerContext: ProgressionIntelligenceContext = {
    playerId: input.playerId,
    date: input.date,
    generatedAt: new Date().toISOString(),
    playerBrief: context.playerBrief,
    dailyContext: context.dailyContext,
    signals: context.signals,
    recentQuestResults: context.recentQuestResults,
    questResponses,
    progressionMap: progressionMapSnapshot,
    playerResponseModel: playerResponseModelSnapshot,
  }

  const provider = requireProvider(dependencies.provider)
  const initialResponse = await provider.invokeStructured({
    operation: 'generate_daily_quests',
    schemaVersion: DAILY_QUEST_INTELLIGENCE_SCHEMA_VERSION,
    instructions: [
      'The Progression Target has already decided what deserves movement today. Do not reopen or replace that strategic decision.',
      'Use Progression Map as the causal source of candidate actions and Player Response Model only for personalized delivery/difficulty calibration.',
      'Use Daily Context as today feasibility/receptivity state, never permanent memory.',
      'Every candidate must cite sourceSignalIds from context.signals and provide a valid strategicChain, feasibility gate, and executionContract.',
      'Quest title should be concise and executable; executionContract carries the precise done condition/context/dose.',
      'The System owns XP and priority mechanics. Do not output XP, selection priority, duplicate rationale, or score grids.',
      'Do not infer effectiveness from compliance alone.',
      questIntelligencePolicyInstructions(),
    ].join(' '),
    context: providerContext,
    responseContract: questResponseContract(),
  })

  const currentMapAfterReasoning = await dependencies.progressionStore.loadCurrentProgressionMap(input.playerId)
  if (!currentMapAfterReasoning || currentMapAfterReasoning.id !== progressionMapSnapshot.id) {
    throw new Error('Progression Map changed during Daily Quest decision')
  }

  const resolved = await validateWithSingleRepair({
    provider,
    initialResponse,
    providerContext,
    allowedSignalIds: new Set(context.signals.map(signal => signal.id)),
    progressionMap: progressionMapSnapshot,
    progressionTarget: intelligence.progressionTarget,
    repairTelemetry: dependencies.repairTelemetry,
  })
  const decision = resolved.decision
  const response = resolved.response
  const audit = auditFrom(response)
  const retrieval = {
    ...retrievalBase,
    questPolicyVersion: QUEST_INTELLIGENCE_POLICY_VERSION,
    questPolicyDecision: compactQuestIntelligenceDecision(decision),
    questPolicyRepair: {
      attempted: resolved.repairAttemptCount === 1,
      repairAttemptCount: resolved.repairAttemptCount,
      ...(resolved.initialValidatorCode ? { initialValidatorCode: resolved.initialValidatorCode } : {}),
      initialRequestId: initialResponse.requestId ?? null,
      finalRequestId: response.requestId ?? null,
    },
  }

  if (decision.quests.length === 0) {
    const noQuestReason = decision.noQuestReason!
    await dependencies.progressionStore.persistNoQuestPlan({
      playerId: input.playerId,
      date: input.date,
      progressionTargetId: intelligence.progressionTarget.id,
      noQuestReason,
      audit,
      retrieval,
    })
    return {
      source: 'no_quest',
      quests: [],
      noQuestReason,
      repairAttemptCount: resolved.repairAttemptCount,
      requestId: response.requestId,
    }
  }

  const persistenceContext: RetrievedPlayerContext = {
    ...context,
    retrieval,
  }
  const quests = await dependencies.repository.persistGeneratedBatch({
    playerId: input.playerId,
    date: input.date,
    candidates: decision.quests,
    audit,
    context: persistenceContext,
  })

  const candidateByKey = new Map(decision.quests.map(quest => [questKey(quest), quest]))
  const metadata = quests.map(quest => {
    const candidate = candidateByKey.get(questKey(quest))
    if (!candidate?.candidateId || !candidate.strategicChain || !candidate.executionContract) {
      throw new Error('Persisted quest could not be matched to intelligence metadata')
    }
    return {
      questId: quest.id,
      candidateId: candidate.candidateId,
      strategicChain: candidate.strategicChain,
      executionContract: candidate.executionContract,
    }
  })
  await dependencies.progressionStore.attachQuestMetadata({
    playerId: input.playerId,
    date: input.date,
    progressionTargetId: intelligence.progressionTarget.id,
    items: metadata,
  })

  return {
    source: 'generated',
    quests,
    repairAttemptCount: resolved.repairAttemptCount,
    requestId: response.requestId,
  }
}
