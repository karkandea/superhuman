import type { AiProvider, ModelAudit } from './contracts'
import type { DailyQuestContextRetriever } from './orchestrator'
import {
  PLAYER_RESPONSE_MODEL_VERSION,
  PROGRESSION_MAP_VERSION,
  PROGRESSION_TARGET_VERSION,
  QUEST_RESPONSE_REVIEW_VERSION,
  compactPlayerResponseModel,
  compactProgressionMap,
  validatePlayerResponseModel,
  validateProgressionMap,
  validateProgressionTarget,
  validateQuestResponseReviews,
  type PlayerResponseModelSnapshot,
  type ProgressionIntelligenceContext,
  type ProgressionMapSnapshot,
  type ProgressionTargetSnapshot,
  type QuestResponseReview,
} from '../progression-intelligence'
import type { ProgressionIntelligenceStore } from '../supabase/progression-intelligence-store'

function requireProvider(provider: AiProvider | undefined): AiProvider {
  if (!provider || typeof provider.invokeStructured !== 'function') {
    throw new Error('AI provider is required; no fake or random fallback is allowed')
  }
  return provider
}

function auditFrom(response: { providerId: string; modelId: string; requestId?: string }, schemaVersion: string): ModelAudit {
  return {
    providerId: response.providerId,
    modelId: response.modelId,
    requestId: response.requestId,
    schemaVersion,
  }
}

function progressionBody(snapshot: ProgressionMapSnapshot) {
  return {
    goals: snapshot.goals,
    proximalOutcomes: snapshot.proximalOutcomes,
    bottlenecks: snapshot.bottlenecks,
    opportunities: snapshot.opportunities,
    uncertainties: snapshot.uncertainties,
  }
}

function responseBody(snapshot: PlayerResponseModelSnapshot) {
  return {
    executionPatterns: snapshot.executionPatterns,
    difficultyCalibration: snapshot.difficultyCalibration,
    receptivityPatterns: snapshot.receptivityPatterns,
    strategyEvidence: snapshot.strategyEvidence,
    uncertainties: snapshot.uncertainties,
  }
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function buildContext(
  contextRetriever: DailyQuestContextRetriever,
  store: ProgressionIntelligenceStore,
  input: { playerId: string; date: string; limit?: number },
): Promise<ProgressionIntelligenceContext> {
  const base = await contextRetriever.retrieveForDailyQuest({
    playerId: input.playerId,
    date: input.date,
    limit: input.limit ?? 32,
  })
  if (!base.playerBrief) throw new Error('Canonical Player Brief is required for progression intelligence')
  const [progressionMap, playerResponseModel, questResponses] = await Promise.all([
    store.loadCurrentProgressionMap(input.playerId),
    store.loadCurrentPlayerResponseModel(input.playerId),
    store.loadQuestResponseEvents(input.playerId, Math.min(24, input.limit ?? 24)),
  ])
  return {
    playerId: input.playerId,
    date: input.date,
    generatedAt: new Date().toISOString(),
    playerBrief: base.playerBrief,
    dailyContext: base.dailyContext,
    signals: base.signals,
    recentQuestResults: base.recentQuestResults,
    questResponses,
    progressionMap,
    playerResponseModel,
  }
}

export async function refreshProgressionMap(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    store: ProgressionIntelligenceStore
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<ProgressionMapSnapshot> {
  const provider = requireProvider(dependencies.provider)
  const context = await buildContext(dependencies.contextRetriever, dependencies.store, input)
  const response = await provider.invokeStructured({
    operation: 'derive_progression_map',
    schemaVersion: PROGRESSION_MAP_VERSION,
    instructions: [
      'Build a compact strategic Progression Map. This is not a quest list and not a rewrite of Player Brief.',
      'Distal goals must be grounded in current Player Brief/signals. Proximal outcomes are the nearest observable changes that would demonstrate movement toward a goal.',
      'Bottlenecks are current constraints that causally hold back one or more proximal outcomes. Opportunities are time-sensitive or high-leverage openings that can accelerate one or more proximal outcomes.',
      'Every node must cite sourceSignalIds from context.signals only. Preserve uncertainty instead of inventing causal certainty.',
      'Use questResponses and Player Response Model as evidence about what is moving or stuck, but completion alone is not proof that an outcome moved.',
      'Do not create goals from one-off Daily Context. Daily Context is temporary and may only help interpret current evidence.',
      'Keep the map bounded and strategic: no tasks, schedules, habits, or candidate quests here.',
    ].join(' '),
    context,
    responseContract: {
      type: 'object',
      required: ['goals', 'proximalOutcomes', 'bottlenecks', 'opportunities', 'uncertainties'],
      goals: [{ nodeId: 'unique short id', summary: 'distal player goal', priority: 'integer 1..5', confidence: 'number 0..1', sourceSignalIds: 'non-empty ids from context.signals' }],
      proximalOutcomes: [{ nodeId: 'unique short id', goalId: 'id from goals', summary: 'nearest observable outcome', importance: 'integer 1..5', confidence: 'number 0..1', sourceSignalIds: 'non-empty ids from context.signals' }],
      bottlenecks: [{ nodeId: 'unique short id', outcomeIds: 'non-empty ids from proximalOutcomes', summary: 'current causal blocker', importance: 'integer 1..5', confidence: 'number 0..1', sourceSignalIds: 'non-empty ids from context.signals' }],
      opportunities: [{ nodeId: 'unique short id', outcomeIds: 'non-empty ids from proximalOutcomes', summary: 'current opening/leverage point', importance: 'integer 1..5', confidence: 'number 0..1', sourceSignalIds: 'non-empty ids from context.signals' }],
      uncertainties: ['short strategic uncertainty strings'],
    },
  })
  const body = validateProgressionMap(response.output, new Set(context.signals.map(signal => signal.id)))
  if (context.progressionMap && sameJson(body, progressionBody(context.progressionMap))) return context.progressionMap
  return dependencies.store.persistProgressionMap({
    playerId: input.playerId,
    map: body,
    signalIds: [...new Set([...body.goals, ...body.proximalOutcomes, ...body.bottlenecks, ...body.opportunities].flatMap(node => node.sourceSignalIds))],
    audit: auditFrom(response, PROGRESSION_MAP_VERSION),
    generatedAt: context.generatedAt,
  })
}

export async function reviewQuestResponses(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    store: ProgressionIntelligenceStore
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<QuestResponseReview[]> {
  const provider = requireProvider(dependencies.provider)
  const context = await buildContext(dependencies.contextRetriever, dependencies.store, input)
  if (context.questResponses.length === 0) return []
  const response = await provider.invokeStructured({
    operation: 'review_quest_responses',
    schemaVersion: QUEST_RESPONSE_REVIEW_VERSION,
    instructions: [
      'Review bounded Quest Response events as behavioral evidence. Never label the player lazy, undisciplined, resistant, or unmotivated without direct evidence.',
      'Separate compliance from effectiveness. completed/partial/skipped/failed tells whether execution happened; it does not by itself prove whether the strategic outcome moved.',
      'Infer a barrier only when repeated response/context/dose evidence supports a concrete hypothesis such as oversized dose, poor timing, low receptivity, unclear completion condition, or an upstream blocker.',
      'Effectiveness must remain unknown unless current downstream player signals provide evidence that the relevant bottleneck/proximal outcome actually moved. Do not treat completion as effectiveness evidence.',
      'If effectiveness is not unknown, cite evidenceSignalIds from context.signals. Keep uncertainty explicit and confidence calibrated.',
    ].join(' '),
    context,
    responseContract: {
      type: 'array',
      items: {
        questId: 'id from context.questResponses only',
        inferredBarrier: 'optional concise hypothesis; omit when unsupported',
        effectiveness: ['unknown', 'none', 'weak', 'moderate', 'strong'],
        effectivenessReason: 'concise explanation distinguishing execution from downstream progress',
        evidenceSignalIds: 'ids from context.signals; empty when effectiveness is unknown',
        confidence: 'number 0..1',
      },
    },
  })
  const reviews = validateQuestResponseReviews(
    response.output,
    new Set(context.questResponses.map(event => event.questId)),
    new Set(context.signals.map(signal => signal.id)),
  )
  await dependencies.store.persistQuestResponseReviews({ playerId: input.playerId, reviews })
  return reviews
}

export async function refreshPlayerResponseModel(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    store: ProgressionIntelligenceStore
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<PlayerResponseModelSnapshot | null> {
  const provider = requireProvider(dependencies.provider)
  const context = await buildContext(dependencies.contextRetriever, dependencies.store, input)
  if (context.questResponses.length === 0) return context.playerResponseModel ?? null
  const response = await provider.invokeStructured({
    operation: 'derive_player_response_model',
    schemaVersion: PLAYER_RESPONSE_MODEL_VERSION,
    instructions: [
      'Build a compact Player Response Model: what delivery patterns appear to work for this specific player.',
      'Use only bounded questResponses. Do not use universal success-rate thresholds or a magic optimal difficulty ratio.',
      'Separate execution patterns, difficulty/dose calibration, receptivity/context patterns, and strategy effectiveness evidence.',
      'A pattern requires actual supporting quest ids. Small samples should remain low-confidence hypotheses, not identity claims.',
      'Partial/skipped/failed outcomes can indicate dose, timing, ambiguity, capacity, or an upstream blocker; do not collapse them into motivation judgments.',
      'Strategy effectiveness must respect each quest response effectiveness review. Unknown means unknown.',
      'preferredAdjustment should describe the next calibration direction, not prescribe a permanent trait.',
    ].join(' '),
    context,
    responseContract: {
      type: 'object',
      required: ['executionPatterns', 'difficultyCalibration', 'receptivityPatterns', 'strategyEvidence', 'uncertainties'],
      executionPatterns: [{ patternId: 'short id', observation: 'behavioral hypothesis', confidence: '0..1', evidenceQuestIds: 'non-empty ids from questResponses', preferredAdjustment: 'next calibration direction' }],
      difficultyCalibration: [{ patternId: 'short id', observation: 'dose/difficulty hypothesis', confidence: '0..1', evidenceQuestIds: 'non-empty ids from questResponses', preferredAdjustment: 'next dose/difficulty adjustment' }],
      receptivityPatterns: [{ patternId: 'short id', observation: 'context/receptivity hypothesis', confidence: '0..1', evidenceQuestIds: 'non-empty ids from questResponses', preferredAdjustment: 'context-sensitive adjustment' }],
      strategyEvidence: [{ evidenceId: 'short id', strategicDriver: 'bottleneck/opportunity/action strategy', effectiveness: ['unknown', 'none', 'weak', 'moderate', 'strong'], confidence: '0..1', evidenceQuestIds: 'non-empty ids from questResponses', reason: 'why this strategy evidence is supported' }],
      uncertainties: ['short unresolved learning questions'],
    },
  })
  const model = validatePlayerResponseModel(response.output, new Set(context.questResponses.map(event => event.questId)))
  if (context.playerResponseModel && sameJson(model, responseBody(context.playerResponseModel))) return context.playerResponseModel
  return dependencies.store.persistPlayerResponseModel({
    playerId: input.playerId,
    model,
    questIds: [...new Set(context.questResponses.map(event => event.questId))],
    audit: auditFrom(response, PLAYER_RESPONSE_MODEL_VERSION),
    generatedAt: context.generatedAt,
  })
}

export async function chooseProgressionTarget(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    store: ProgressionIntelligenceStore
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<ProgressionTargetSnapshot> {
  const existing = await dependencies.store.loadProgressionTargetForDate(input.playerId, input.date)
  if (existing) return existing
  const provider = requireProvider(dependencies.provider)
  const context = await buildContext(dependencies.contextRetriever, dependencies.store, input)
  if (!context.dailyContext) throw new Error('Daily Context is required before choosing today progression target')
  if (!context.progressionMap) throw new Error('Progression Map is required before choosing today progression target')

  const response = await provider.invokeStructured({
    operation: 'choose_progression_target',
    schemaVersion: PROGRESSION_TARGET_VERSION,
    instructions: [
      'Choose what should move today before generating any candidate quests. This is a strategic decision, not a task list.',
      'Use Progression Map to connect distal goal -> proximal outcome -> current bottleneck/opportunity. Use Player Response Model only as personalization evidence, never as a fixed identity.',
      'Use Daily Context as the receptivity/capacity gate for this date. Good interventions that are not feasible/receptive today should lose priority.',
      'mode=progress when a proximal outcome has a worthwhile bottleneck/opportunity to move now. mode=maintenance_only when protecting baseline capacity is the only justified intervention. mode=no_intervention when adding a quest would mainly create burden, all critical progress is already covered, or evidence is too uncertain.',
      'No-intervention is a valid intelligent decision. Do not invent work to fill slots.',
      'maxQuestCount is a ceiling based on today, not a target to fill.',
    ].join(' '),
    context,
    responseContract: {
      type: 'object',
      required: ['mode', 'summary', 'proximalOutcomeIds', 'bottleneckIds', 'opportunityIds', 'maxQuestCount', 'rationale'],
      mode: ['progress', 'maintenance_only', 'no_intervention'],
      summary: 'what should move today',
      primaryGoalId: 'goal id from progressionMap when mode=progress; optional otherwise',
      proximalOutcomeIds: 'ids from progressionMap.proximalOutcomes',
      bottleneckIds: 'ids from progressionMap.bottlenecks',
      opportunityIds: 'ids from progressionMap.opportunities',
      maintenanceIntent: 'optional baseline protection intent',
      maxQuestCount: 'integer 0..5; 0 only for no_intervention',
      rationale: 'concise strategic reason grounded in map + response model + Daily Context',
      noQuestReason: 'required when mode=no_intervention',
    },
  })
  const decision = validateProgressionTarget(response.output, context.progressionMap)
  return dependencies.store.persistProgressionTarget({
    playerId: input.playerId,
    date: input.date,
    progressionMapId: context.progressionMap.id,
    playerResponseModelId: context.playerResponseModel?.id,
    dailyContextId: context.dailyContext.id,
    decision,
    audit: auditFrom(response, PROGRESSION_TARGET_VERSION),
  })
}

export async function loadQuestGenerationIntelligence(
  store: ProgressionIntelligenceStore,
  input: { playerId: string; date: string },
) {
  const [progressionMap, playerResponseModel, progressionTarget] = await Promise.all([
    store.loadCurrentProgressionMap(input.playerId),
    store.loadCurrentPlayerResponseModel(input.playerId),
    store.loadProgressionTargetForDate(input.playerId, input.date),
  ])
  return {
    progressionMap: progressionMap ? compactProgressionMap(progressionMap) : null,
    playerResponseModel: compactPlayerResponseModel(playerResponseModel),
    progressionTarget,
  }
}
