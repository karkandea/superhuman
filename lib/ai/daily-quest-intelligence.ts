import type { AiProvider, ModelAudit } from './contracts'
import type { DailyQuestContextRetriever, DailyQuestRepository } from './orchestrator'
import {
  loadQuestGenerationIntelligence,
} from './progression-intelligence'
import {
  QUEST_INTELLIGENCE_POLICY_VERSION,
  compactQuestIntelligenceDecision,
  questIntelligencePolicyInstructions,
  validateQuestIntelligenceDecision,
} from '../quest-intelligence-policy'
import type { ProgressionIntelligenceContext } from '../progression-intelligence'
import type { RetrievedPlayerContext } from '../player-understanding'
import type { PersistedDailyQuest } from '../quest-system'
import type { ProgressionIntelligenceStore } from '../supabase/progression-intelligence-store'

export const DAILY_QUEST_INTELLIGENCE_SCHEMA_VERSION = 'daily-quest.v3'

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

export async function generateDailyQuestsWithIntelligence(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    repository: DailyQuestRepository
    progressionStore: ProgressionIntelligenceStore
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<{ source: 'existing' | 'generated' | 'awaiting_context' | 'no_quest'; quests: PersistedDailyQuest[]; noQuestReason?: string }> {
  if (!input.playerId) throw new Error('playerId is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('date must use YYYY-MM-DD')

  const existing = await dependencies.repository.findForDate(input.playerId, input.date)
  if (existing.length > 0) return { source: 'existing', quests: existing }
  if (await dependencies.progressionStore.hasNoQuestPlanForDate(input.playerId, input.date)) {
    const target = await dependencies.progressionStore.loadProgressionTargetForDate(input.playerId, input.date)
    return { source: 'no_quest', quests: [], ...(target?.noQuestReason ? { noQuestReason: target.noQuestReason } : {}) }
  }

  const context = await dependencies.contextRetriever.retrieveForDailyQuest({
    playerId: input.playerId,
    date: input.date,
    limit: input.limit ?? 32,
  })
  if (context.playerId !== input.playerId) throw new Error('Retrieved context belongs to another player')
  if (!context.playerBrief) throw new Error('Canonical Player Brief is required for Daily Quest generation')
  if (!context.dailyContext) return { source: 'awaiting_context', quests: [] }
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
    return { source: 'no_quest', quests: [], noQuestReason }
  }

  if (context.signals.length === 0) throw new Error('Daily quests require evidence-backed player signals; generation stopped')
  const questResponses = await dependencies.progressionStore.loadQuestResponseEvents(input.playerId, 24)
  const providerContext: ProgressionIntelligenceContext = {
    playerId: input.playerId,
    date: input.date,
    generatedAt: new Date().toISOString(),
    playerBrief: context.playerBrief,
    dailyContext: context.dailyContext,
    signals: context.signals,
    recentQuestResults: context.recentQuestResults,
    questResponses,
    progressionMap: intelligence.progressionMap,
    playerResponseModel: intelligence.playerResponseModel,
  }

  const provider = requireProvider(dependencies.provider)
  const response = await provider.invokeStructured({
    operation: 'generate_daily_quests',
    schemaVersion: DAILY_QUEST_INTELLIGENCE_SCHEMA_VERSION,
    instructions: [
      'The Progression Target has already decided what deserves movement today. Do not reopen or replace that strategic decision.',
      'Use Progression Map as the causal source of candidate actions and Player Response Model only for personalized delivery/difficulty calibration.',
      'Use Daily Context as today feasibility/receptivity state, never permanent memory.',
      'Every candidate must cite sourceSignalIds from context.signals and provide a valid strategicChain, feasibility gate, and executionContract.',
      'Quest title should be concise and executable; executionContract carries the precise done condition/context/dose.',
      'Do not infer effectiveness from compliance alone.',
      questIntelligencePolicyInstructions(),
    ].join(' '),
    context: providerContext,
    responseContract: {
      type: 'object',
      required: ['candidates', 'selections'],
      candidates: [{
        candidateId: 'unique short non-empty string',
        title: 'concise executable action',
        category: ['pagi', 'siang', 'malam', 'sepanjang_hari'],
        difficulty: ['easy', 'medium', 'hard'],
        xp: 'non-negative integer',
        rationale: 'concise evidence-backed reason',
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
        scores: {
          goalRelevance: 'integer 0..5', urgency: 'integer 0..5', leverage: 'integer 0..5', obstacleRemoval: 'integer 0..5',
          actionability: 'integer 0..5', contextFit: 'integer 0..5', progressionValue: 'integer 0..5', redundancyPenalty: 'integer 0..5',
        },
      }],
      selections: [{
        candidateId: 'id from candidates only',
        kind: ['main', 'side', 'maintenance', 'bonus'],
        priority: 'integer 1..5',
        selectionReason: 'why it belongs in this portfolio',
      }],
      noQuestReason: 'required only when selections is empty',
    },
  })

  const progressionMapSnapshot = await dependencies.progressionStore.loadCurrentProgressionMap(input.playerId)
  if (!progressionMapSnapshot || progressionMapSnapshot.id !== intelligence.progressionMap.id) {
    throw new Error('Progression Map changed during Daily Quest decision')
  }
  const decision = validateQuestIntelligenceDecision(
    response.output,
    new Set(context.signals.map(signal => signal.id)),
    { progressionMap: progressionMapSnapshot, progressionTarget: intelligence.progressionTarget },
  )
  const audit = auditFrom(response)
  const retrieval = {
    ...retrievalBase,
    questPolicyVersion: QUEST_INTELLIGENCE_POLICY_VERSION,
    questPolicyDecision: compactQuestIntelligenceDecision(decision),
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
    return { source: 'no_quest', quests: [], noQuestReason }
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

  return { source: 'generated', quests }
}
