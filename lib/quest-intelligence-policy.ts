import {
  type ProgressionMapSnapshot,
  type ProgressionTargetSnapshot,
  type QuestExecutionContract,
  type QuestFeasibilityAssessment,
  type QuestStrategicChain,
} from './progression-intelligence'
import { validateGeneratedQuestCandidates, type GeneratedQuestCandidate, type QuestKind } from './quest-system'

export const QUEST_INTELLIGENCE_POLICY_VERSION = 'quest-policy.v2'
export const QUEST_CANDIDATE_MIN = 8
export const QUEST_CANDIDATE_ACCEPT_MIN = 4
export const QUEST_CANDIDATE_MAX = 15
export const QUEST_SELECTION_MAX = 5

export const QUEST_SCORE_DIMENSIONS = [
  'goalRelevance',
  'urgency',
  'leverage',
  'obstacleRemoval',
  'actionability',
  'contextFit',
  'progressionValue',
  'redundancyPenalty',
] as const

export type QuestScoreDimension = (typeof QUEST_SCORE_DIMENSIONS)[number]
export type QuestPolicyScores = Record<QuestScoreDimension, number>

export interface QuestPolicyCandidate {
  candidateId: string
  title: string
  category: GeneratedQuestCandidate['category']
  difficulty: GeneratedQuestCandidate['difficulty']
  xp: number
  rationale: string
  sourceSignalIds: string[]
  strategicChain: QuestStrategicChain
  feasibility: QuestFeasibilityAssessment
  executionContract: QuestExecutionContract
  scores: QuestPolicyScores
}

export interface QuestPolicySelection {
  candidateId: string
  kind: QuestKind
  priority: GeneratedQuestCandidate['priority']
  selectionReason: string
}

export interface QuestPolicyDecision {
  candidates: QuestPolicyCandidate[]
  selections: QuestPolicySelection[]
  quests: GeneratedQuestCandidate[]
  noQuestReason?: string
}

export interface QuestPolicyValidationContext {
  progressionMap: ProgressionMapSnapshot
  progressionTarget: ProgressionTargetSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, field: string, max = 1600) {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result) throw new Error(`${field} must be a non-empty string`)
  if (result.length > max) throw new Error(`${field} is too long`)
  return result
}

function optionalString(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined
  return nonEmptyString(value, field, 240)
}

function normalizeQuestCategory(value: unknown): GeneratedQuestCandidate['category'] | unknown {
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLocaleLowerCase().replace(/[\s-]+/g, '_')
  const aliases: Record<string, GeneratedQuestCandidate['category']> = {
    pagi: 'pagi',
    morning: 'pagi',
    siang: 'siang',
    noon: 'siang',
    midday: 'siang',
    afternoon: 'siang',
    malam: 'malam',
    sore: 'malam',
    evening: 'malam',
    night: 'malam',
    sepanjang_hari: 'sepanjang_hari',
    all_day: 'sepanjang_hari',
    allday: 'sepanjang_hari',
    anytime: 'sepanjang_hari',
    any_time: 'sepanjang_hari',
    throughout_day: 'sepanjang_hari',
  }
  return aliases[normalized] ?? value
}

function signalIds(value: unknown, field: string, allowedSignalIds: ReadonlySet<string>) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must contain source signal ids`)
  }
  const result = [...new Set(value.map(item => String(item).trim()))]
  if (result.some(id => !allowedSignalIds.has(id))) throw new Error(`${field} references a signal outside retrieved context`)
  return result
}

function scores(value: unknown, index: number): QuestPolicyScores {
  if (!isRecord(value)) throw new Error(`Quest candidate ${index} requires policy scores`)
  const result = {} as QuestPolicyScores
  for (const dimension of QUEST_SCORE_DIMENSIONS) {
    const score = value[dimension]
    if (!Number.isInteger(score) || Number(score) < 0 || Number(score) > 5) {
      throw new Error(`Quest candidate ${index} score ${dimension} must be an integer from 0 to 5`)
    }
    result[dimension] = Number(score)
  }
  return result
}

function executionContract(value: unknown, index: number): QuestExecutionContract {
  if (!isRecord(value)) throw new Error(`Quest candidate ${index} requires an executionContract`)
  return {
    action: nonEmptyString(value.action, `Quest candidate ${index} execution action`),
    completionCondition: nonEmptyString(value.completionCondition, `Quest candidate ${index} completion condition`),
    appropriateContext: nonEmptyString(value.appropriateContext, `Quest candidate ${index} appropriate context`),
    dose: nonEmptyString(value.dose, `Quest candidate ${index} dose`, 500),
  }
}

function feasibility(value: unknown, index: number): QuestFeasibilityAssessment {
  if (!isRecord(value)) throw new Error(`Quest candidate ${index} requires feasibility assessment`)
  if (typeof value.feasibleToday !== 'boolean') throw new Error(`Quest candidate ${index} feasibility requires feasibleToday`)
  if (!['low', 'medium', 'high', 'unknown'].includes(String(value.receptivity))) {
    throw new Error(`Quest candidate ${index} has invalid receptivity`)
  }
  if (!Number.isInteger(value.estimatedMinutes) || Number(value.estimatedMinutes) < 1 || Number(value.estimatedMinutes) > 480) {
    throw new Error(`Quest candidate ${index} estimatedMinutes must be an integer from 1 to 480`)
  }
  return {
    feasibleToday: value.feasibleToday,
    receptivity: value.receptivity as QuestFeasibilityAssessment['receptivity'],
    estimatedMinutes: Number(value.estimatedMinutes),
    reason: nonEmptyString(value.reason, `Quest candidate ${index} feasibility reason`),
  }
}

function strategicChain(value: unknown, index: number, validation: QuestPolicyValidationContext): QuestStrategicChain {
  if (!isRecord(value)) throw new Error(`Quest candidate ${index} requires a strategicChain`)
  if (!['bottleneck', 'opportunity', 'maintenance'].includes(String(value.driverType))) {
    throw new Error(`Quest candidate ${index} has invalid strategic driver type`)
  }
  const driverType = value.driverType as QuestStrategicChain['driverType']
  const goalId = optionalString(value.goalId, `Quest candidate ${index} goalId`)
  const proximalOutcomeId = optionalString(value.proximalOutcomeId, `Quest candidate ${index} proximalOutcomeId`)
  const driverId = optionalString(value.driverId, `Quest candidate ${index} driverId`)

  const goalById = new Map(validation.progressionMap.goals.map(goal => [goal.nodeId, goal]))
  const outcomeById = new Map(validation.progressionMap.proximalOutcomes.map(outcome => [outcome.nodeId, outcome]))
  const bottleneckById = new Map(validation.progressionMap.bottlenecks.map(driver => [driver.nodeId, driver]))
  const opportunityById = new Map(validation.progressionMap.opportunities.map(driver => [driver.nodeId, driver]))

  if (driverType !== 'maintenance') {
    if (!goalId || !goalById.has(goalId)) throw new Error(`Quest candidate ${index} strategic chain requires a valid goal`)
    if (!proximalOutcomeId || !outcomeById.has(proximalOutcomeId)) throw new Error(`Quest candidate ${index} strategic chain requires a valid proximal outcome`)
    if (outcomeById.get(proximalOutcomeId)!.goalId !== goalId) throw new Error(`Quest candidate ${index} strategic chain crosses unrelated goal/outcome nodes`)
    if (!driverId) throw new Error(`Quest candidate ${index} strategic chain requires a driver id`)
    const driver = driverType === 'bottleneck' ? bottleneckById.get(driverId) : opportunityById.get(driverId)
    if (!driver) throw new Error(`Quest candidate ${index} strategic chain references an unknown ${driverType}`)
    if (!driver.outcomeIds.includes(proximalOutcomeId)) throw new Error(`Quest candidate ${index} strategic driver does not affect the selected proximal outcome`)
  } else {
    if (goalId && !goalById.has(goalId)) throw new Error(`Quest candidate ${index} maintenance chain references an unknown goal`)
    if (proximalOutcomeId && !outcomeById.has(proximalOutcomeId)) throw new Error(`Quest candidate ${index} maintenance chain references an unknown proximal outcome`)
    if (driverId) throw new Error(`Quest candidate ${index} maintenance chain must not invent a strategic driver id`)
  }

  return {
    ...(goalId ? { goalId } : {}),
    ...(proximalOutcomeId ? { proximalOutcomeId } : {}),
    driverType,
    ...(driverId ? { driverId } : {}),
    causalReason: nonEmptyString(value.causalReason, `Quest candidate ${index} causal reason`),
  }
}

function enforceProgressionTargetCeiling(
  selections: QuestPolicySelection[],
  maxQuestCount: number,
): QuestPolicySelection[] {
  if (selections.length <= maxQuestCount) return selections
  if (maxQuestCount < 1) throw new Error('Progression Target permits no Daily Quest selections')

  const main = selections.find(selection => selection.kind === 'main')
  if (!main) return selections

  const otherSlots = Math.max(0, maxQuestCount - 1)
  const rankedOthers = selections
    .map((selection, index) => ({ selection, index }))
    .filter(item => item.selection.kind !== 'main')
    .sort((left, right) => right.selection.priority - left.selection.priority || left.index - right.index)
    .slice(0, otherSlots)
    .map(item => item.selection.candidateId)

  const kept = new Set([main.candidateId, ...rankedOthers])
  return selections.filter(selection => kept.has(selection.candidateId))
}

export function questIntelligencePolicyInstructions() {
  return [
    'QUEST POLICY / CONSTITUTION V2:',
    'Choose only what most deserves the player’s attention today; do not mirror every goal.',
    'Candidates must follow the strategic chain Distal Goal -> Proximal Outcome -> current Bottleneck/Opportunity -> candidate action. Maintenance may protect baseline capacity without inventing a bottleneck.',
    'Apply feasibility/receptivity before scoring. A strategically attractive option that cannot realistically be executed today must be feasibleToday=false and cannot be selected.',
    'Every candidate needs an executable contract: concrete action, observable completion condition, appropriate context, and reasonable dose. Avoid vague tasks without a bounded done condition.',
    'Create 8–15 distinct evidence-backed candidates when today’s Progression Target calls for intervention.',
    'Use category exactly as one of pagi, siang, malam, sepanjang_hari. Do not translate or invent category values.',
    'Score every candidate 0–5 on goalRelevance, urgency, leverage, obstacleRemoval, actionability, contextFit, progressionValue, and redundancyPenalty. Do not collapse these into a blind weighted formula.',
    'Select a portfolio rather than top-N. If any quest is selected: exactly 1 Main, at most 2 Side, at most 1 Maintenance, at most 1 Bonus, and never exceed Progression Target maxQuestCount.',
    'Selecting zero quests is valid when every option fails feasibility/receptivity, critical progress is already covered, uncertainty is too high, or another quest would mainly add burden. Provide noQuestReason.',
    'Never invent filler. A single focused Main Quest is valid when capacity is low.',
    'Use Daily Context only as temporary state for this date. Use Player Response Model as calibration evidence, not identity.',
    'Repeated successful execution may justify modest dose/difficulty progression; repeated partial/skipped/failed execution should shrink, simplify, reschedule, or attack the upstream blocker instead of repeating the same oversized quest.',
    'Completion is compliance evidence, not automatic strategy effectiveness. No universal success-rate or difficulty ratio should be assumed.',
    'Priority uses 5 as highest and 1 as lowest. Time-of-day category is scheduling context, not a life-domain taxonomy.',
  ].join(' ')
}

export function validateQuestIntelligenceDecision(
  value: unknown,
  allowedSignalIds: ReadonlySet<string>,
  validation: QuestPolicyValidationContext,
): QuestPolicyDecision {
  if (!isRecord(value)) throw new Error('Quest Policy V2 output must be an object')
  if (!Array.isArray(value.candidates) || value.candidates.length < QUEST_CANDIDATE_ACCEPT_MIN || value.candidates.length > QUEST_CANDIDATE_MAX) {
    throw new Error(`Quest Policy V2 must produce at least ${QUEST_CANDIDATE_ACCEPT_MIN} usable candidates (${QUEST_CANDIDATE_MIN}–${QUEST_CANDIDATE_MAX} requested)`)
  }
  if (!Array.isArray(value.selections) || value.selections.length > QUEST_SELECTION_MAX) {
    throw new Error(`Quest Policy V2 must select 0–${QUEST_SELECTION_MAX} quests`)
  }

  const seenCandidateIds = new Set<string>()
  const seenTitles = new Set<string>()
  const candidates: QuestPolicyCandidate[] = value.candidates.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Quest candidate ${index} must be an object`)
    const candidateId = nonEmptyString(raw.candidateId, `Quest candidate ${index} candidateId`, 120)
    if (seenCandidateIds.has(candidateId)) throw new Error('Quest candidate ids must be unique')
    seenCandidateIds.add(candidateId)

    const [validated] = validateGeneratedQuestCandidates([{
      title: raw.title,
      category: normalizeQuestCategory(raw.category),
      kind: 'side',
      difficulty: raw.difficulty,
      priority: 3,
      xp: raw.xp,
      rationale: raw.rationale,
      sourceSignalIds: raw.sourceSignalIds,
    }], allowedSignalIds)
    const normalizedTitle = validated.title.toLocaleLowerCase()
    if (seenTitles.has(normalizedTitle)) throw new Error('Quest candidate titles must be distinct')
    seenTitles.add(normalizedTitle)

    return {
      candidateId,
      title: validated.title,
      category: validated.category,
      difficulty: validated.difficulty,
      xp: validated.xp,
      rationale: validated.rationale,
      sourceSignalIds: signalIds(raw.sourceSignalIds, `Quest candidate ${index} sourceSignalIds`, allowedSignalIds),
      strategicChain: strategicChain(raw.strategicChain, index, validation),
      feasibility: feasibility(raw.feasibility, index),
      executionContract: executionContract(raw.executionContract, index),
      scores: scores(raw.scores, index),
    }
  })

  const candidateById = new Map(candidates.map(candidate => [candidate.candidateId, candidate]))
  const selectedIds = new Set<string>()
  const parsedSelections: QuestPolicySelection[] = value.selections.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Quest selection ${index} must be an object`)
    const candidateId = nonEmptyString(raw.candidateId, `Quest selection ${index} candidateId`, 120)
    const candidate = candidateById.get(candidateId)
    if (!candidate) throw new Error(`Quest selection ${index} references a candidate outside the candidate pool`)
    if (!candidate.feasibility.feasibleToday) throw new Error(`Quest selection ${index} selected a candidate that failed feasibility/receptivity gate`)
    if (selectedIds.has(candidateId)) throw new Error('Quest selections must reference distinct candidates')
    selectedIds.add(candidateId)

    const kind = raw.kind
    if (!['main', 'side', 'maintenance', 'bonus'].includes(String(kind))) throw new Error(`Quest selection ${index} has invalid kind`)
    const priority = raw.priority
    if (!Number.isInteger(priority) || Number(priority) < 1 || Number(priority) > 5) throw new Error(`Quest selection ${index} has invalid priority`)
    return {
      candidateId,
      kind: kind as QuestKind,
      priority: Number(priority) as GeneratedQuestCandidate['priority'],
      selectionReason: nonEmptyString(raw.selectionReason, `Quest selection ${index} selectionReason`),
    }
  })

  const rawCount = (kind: QuestKind) => parsedSelections.filter(selection => selection.kind === kind).length
  if (parsedSelections.length > 0 && rawCount('main') !== 1) throw new Error('Quest portfolio with quests must contain exactly one Main Quest')
  if (rawCount('side') > 2) throw new Error('Quest portfolio may contain at most two Side Quests')
  if (rawCount('maintenance') > 1) throw new Error('Quest portfolio may contain at most one Maintenance Quest')
  if (rawCount('bonus') > 1) throw new Error('Quest portfolio may contain at most one Bonus Quest')

  const selections = enforceProgressionTargetCeiling(parsedSelections, validation.progressionTarget.maxQuestCount)
  const count = (kind: QuestKind) => selections.filter(selection => selection.kind === kind).length
  if (selections.length > 0 && count('main') !== 1) throw new Error('Quest portfolio with quests must contain exactly one Main Quest')

  const noQuestReason = optionalString(value.noQuestReason, 'Quest Policy noQuestReason')
  if (selections.length === 0 && !noQuestReason) throw new Error('Quest Policy selecting zero quests requires noQuestReason')
  if (selections.length > 0 && noQuestReason) throw new Error('Quest Policy must omit noQuestReason when quests are selected')

  const quests = selections.map(selection => {
    const candidate = candidateById.get(selection.candidateId)!
    return {
      title: candidate.title,
      category: candidate.category,
      kind: selection.kind,
      difficulty: candidate.difficulty,
      priority: selection.priority,
      xp: candidate.xp,
      rationale: candidate.strategicChain.causalReason,
      sourceSignalIds: candidate.sourceSignalIds,
      candidateId: candidate.candidateId,
      strategicChain: candidate.strategicChain,
      executionContract: candidate.executionContract,
    } satisfies GeneratedQuestCandidate
  })

  return { candidates, selections, quests, ...(noQuestReason ? { noQuestReason } : {}) }
}

export function compactQuestIntelligenceDecision(decision: QuestPolicyDecision) {
  return {
    version: QUEST_INTELLIGENCE_POLICY_VERSION,
    candidateCount: decision.candidates.length,
    requestedCandidateMin: QUEST_CANDIDATE_MIN,
    degradedCandidatePool: decision.candidates.length < QUEST_CANDIDATE_MIN,
    candidates: decision.candidates.map(candidate => ({
      id: candidate.candidateId,
      scores: candidate.scores,
      feasibility: candidate.feasibility,
      strategicChain: candidate.strategicChain,
    })),
    selections: decision.selections.map(selection => ({
      candidateId: selection.candidateId,
      kind: selection.kind,
      priority: selection.priority,
      reason: selection.selectionReason,
    })),
    ...(decision.noQuestReason ? { noQuestReason: decision.noQuestReason } : {}),
  }
}
