import {
  type ProgressionMapSnapshot,
  type ProgressionTargetSnapshot,
  type QuestExecutionContract,
  type QuestFeasibilityAssessment,
  type QuestStrategicChain,
} from './progression-intelligence'
import { validateGeneratedQuestCandidates, type GeneratedQuestCandidate, type QuestKind } from './quest-system'

export const QUEST_INTELLIGENCE_POLICY_VERSION = 'quest-policy.v3'
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
  /** Backward-compatible diagnostic only. Selection does not depend on this grid. */
  scores?: QuestPolicyScores
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

export type QuestPolicyValidatorCode =
  | 'candidate_pool_invalid'
  | 'candidate_category_invalid'
  | 'candidate_identity_invalid'
  | 'candidate_provenance_invalid'
  | 'strategic_chain_invalid'
  | 'feasibility_invalid'
  | 'execution_contract_invalid'
  | 'selection_invalid'
  | 'portfolio_invalid'
  | 'no_quest_reason_invalid'
  | 'unknown_validation_error'

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

function optionalScores(value: unknown, index: number): QuestPolicyScores | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error(`Quest candidate ${index} policy scores must be an object when supplied`)
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

function deterministicPriority(kind: QuestKind): GeneratedQuestCandidate['priority'] {
  if (kind === 'main') return 5
  if (kind === 'side') return 4
  if (kind === 'maintenance') return 3
  return 2
}

export function deterministicQuestXp(
  difficulty: GeneratedQuestCandidate['difficulty'],
  kind: QuestKind,
): number {
  const base = difficulty === 'hard' ? 100 : difficulty === 'medium' ? 75 : 50
  if (kind === 'main') return base + 50
  if (kind === 'bonus') return base + 25
  if (kind === 'maintenance') return Math.max(40, base - 10)
  return base
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
    'QUEST POLICY / CONSTITUTION V3:',
    'Choose only what most deserves the player’s attention today; do not mirror every goal.',
    'Candidates must follow Distal Goal -> Proximal Outcome -> current Bottleneck/Opportunity -> candidate action. Maintenance may protect baseline capacity without inventing a bottleneck.',
    'Apply feasibility/receptivity before selecting. A strategically attractive option that cannot realistically be executed today must be feasibleToday=false and cannot be selected.',
    'Every candidate needs an executable contract: concrete action, observable completion condition, appropriate context, and reasonable dose.',
    'Create 8–15 distinct evidence-backed candidates when today’s Progression Target calls for intervention. Four usable candidates is the bounded degraded minimum; never invent filler just to hit a count.',
    'Use category exactly as one of pagi, siang, malam, sepanjang_hari. Do not translate or invent category values.',
    'Consider goal relevance, urgency, leverage, obstacle removal, actionability, context fit, progression value, and redundancy while reasoning, but do not return a mechanical score grid.',
    'Select a portfolio rather than top-N. If any quest is selected: exactly 1 Main, at most 2 Side, at most 1 Maintenance, at most 1 Bonus, and never exceed Progression Target maxQuestCount.',
    'Order selections from most important to least important. The System derives priority and XP deterministically; do not output either field.',
    'Selecting zero quests is valid when every option fails feasibility/receptivity, critical progress is already covered, uncertainty is too high, or another quest would mainly add burden. Provide noQuestReason.',
    'Never invent filler. A single focused Main Quest is valid when capacity is low.',
    'Use Daily Context only as temporary state for this date. Use Player Response Model as calibration evidence, not identity.',
    'Repeated successful execution may justify modest dose/difficulty progression; repeated partial/skipped/failed execution should shrink, simplify, reschedule, or attack the upstream blocker.',
    'Completion is compliance evidence, not automatic strategy effectiveness.',
  ].join(' ')
}

export function questPolicyValidatorCode(error: unknown): QuestPolicyValidatorCode {
  const message = error instanceof Error ? error.message : String(error)
  if (/candidate.*(at least|produce|pool)|candidates/i.test(message) && /usable|produce|pool|at least/i.test(message)) return 'candidate_pool_invalid'
  if (/invalid category/i.test(message)) return 'candidate_category_invalid'
  if (/candidate ids|candidateId|title|distinct/i.test(message)) return 'candidate_identity_invalid'
  if (/sourceSignalIds|source signal|outside retrieved context/i.test(message)) return 'candidate_provenance_invalid'
  if (/strategic chain|strategic driver|goal|proximal outcome/i.test(message)) return 'strategic_chain_invalid'
  if (/feasibility|receptivity|estimatedMinutes/i.test(message)) return 'feasibility_invalid'
  if (/executionContract|execution contract|completion condition|dose/i.test(message)) return 'execution_contract_invalid'
  if (/Quest selection|selection.*candidate|invalid kind|distinct candidates/i.test(message)) return 'selection_invalid'
  if (/portfolio|Main Quest|Side Quest|Maintenance Quest|Bonus Quest/i.test(message)) return 'portfolio_invalid'
  if (/noQuestReason/i.test(message)) return 'no_quest_reason_invalid'
  return 'unknown_validation_error'
}

export function validateQuestIntelligenceDecision(
  value: unknown,
  allowedSignalIds: ReadonlySet<string>,
  validation: QuestPolicyValidationContext,
): QuestPolicyDecision {
  if (!isRecord(value)) throw new Error('Quest Policy V3 output must be an object')
  if (!Array.isArray(value.candidates) || value.candidates.length < QUEST_CANDIDATE_ACCEPT_MIN || value.candidates.length > QUEST_CANDIDATE_MAX) {
    throw new Error(`Quest Policy V3 must produce at least ${QUEST_CANDIDATE_ACCEPT_MIN} usable candidates (${QUEST_CANDIDATE_MIN}–${QUEST_CANDIDATE_MAX} requested)`)
  }
  if (!Array.isArray(value.selections) || value.selections.length > QUEST_SELECTION_MAX) {
    throw new Error(`Quest Policy V3 must select 0–${QUEST_SELECTION_MAX} quests`)
  }

  const seenCandidateIds = new Set<string>()
  const seenTitles = new Set<string>()
  const candidates: QuestPolicyCandidate[] = value.candidates.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Quest candidate ${index} must be an object`)
    const candidateId = nonEmptyString(raw.candidateId, `Quest candidate ${index} candidateId`, 120)
    if (seenCandidateIds.has(candidateId)) throw new Error('Quest candidate ids must be unique')
    seenCandidateIds.add(candidateId)

    const chain = strategicChain(raw.strategicChain, index, validation)
    const [validated] = validateGeneratedQuestCandidates([{
      title: raw.title,
      category: normalizeQuestCategory(raw.category),
      kind: 'side',
      difficulty: raw.difficulty,
      priority: 4,
      xp: 50,
      rationale: chain.causalReason,
      sourceSignalIds: raw.sourceSignalIds,
    }], allowedSignalIds)
    const normalizedTitle = validated.title.toLocaleLowerCase()
    if (seenTitles.has(normalizedTitle)) throw new Error('Quest candidate titles must be distinct')
    seenTitles.add(normalizedTitle)

    const candidateScores = optionalScores(raw.scores, index)
    return {
      candidateId,
      title: validated.title,
      category: validated.category,
      difficulty: validated.difficulty,
      xp: deterministicQuestXp(validated.difficulty, 'side'),
      rationale: chain.causalReason,
      sourceSignalIds: signalIds(raw.sourceSignalIds, `Quest candidate ${index} sourceSignalIds`, allowedSignalIds),
      strategicChain: chain,
      feasibility: feasibility(raw.feasibility, index),
      executionContract: executionContract(raw.executionContract, index),
      ...(candidateScores ? { scores: candidateScores } : {}),
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
    return {
      candidateId,
      kind: kind as QuestKind,
      priority: deterministicPriority(kind as QuestKind),
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
      xp: deterministicQuestXp(candidate.difficulty, selection.kind),
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
    mechanicsOwnedBySystem: ['xp', 'priority'],
    candidates: decision.candidates.map(candidate => ({
      id: candidate.candidateId,
      ...(candidate.scores ? { scores: candidate.scores } : {}),
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
