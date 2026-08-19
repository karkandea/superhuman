import { validateGeneratedQuestCandidates, type GeneratedQuestCandidate, type QuestKind } from './quest-system'

export const QUEST_POLICY_VERSION = 'quest-policy.v1'
export const QUEST_CANDIDATE_MIN = 8
export const QUEST_CANDIDATE_MAX = 15
export const QUEST_SELECTION_MIN = 2
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, field: string) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${field} must be a non-empty string`)
  return text
}

function signalIds(value: unknown, field: string, allowedSignalIds: ReadonlySet<string>) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must contain source signal ids`)
  }
  const ids = [...new Set(value.map(item => String(item).trim()))]
  if (ids.some(id => !allowedSignalIds.has(id))) throw new Error(`${field} references a signal outside retrieved context`)
  return ids
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

export function questPolicyInstructions() {
  return [
    'QUEST POLICY / CONSTITUTION:',
    'The objective is not to represent every player goal. Choose what most deserves the player’s attention today.',
    'First create an internal pool of 8–15 distinct, evidence-backed candidate actions. Do not jump directly to final quests.',
    'Score every candidate from 0–5 on goalRelevance, urgency, leverage, obstacleRemoval, actionability, contextFit, progressionValue, and redundancyPenalty.',
    'A high redundancyPenalty means the action has been repeated recently without enough new value. Do not calculate one blind weighted total; use the dimensions as a consistent decision frame.',
    'Then choose a portfolio, not simply the top numerical scores: exactly 1 Main Quest, at most 2 Side Quests, at most 1 Maintenance Quest, and at most 1 Bonus Quest; total 2–5 quests.',
    'Never invent filler just to occupy a slot. Fewer quests are correct when capacity is low or one action deserves concentrated attention.',
    'Daily Context is temporary state for this target date only. Use it to fit time, health, location, travel, appointments, energy, or unusual commitments, but never turn it into permanent identity or player memory.',
    'Normal day means no unusual temporary constraint was reported. It does not mean unlimited time or energy.',
    'Use recent quest outcomes to calibrate difficulty. Repeated successful execution can justify a modest progression step; repeated partial/skipped/failed execution should simplify, shrink, reschedule, or target the actual blocker instead of repeating the same oversized quest.',
    'Failure is calibration data, not punishment. Progression should stretch the player slightly without ignoring real capacity.',
    'When a bottleneck is visible, prefer actions that remove that bottleneck over more learning/activity in areas already progressing well.',
    'Priority uses 5 as highest and 1 as lowest. Quest time-of-day category is scheduling context, not a life-domain taxonomy.',
  ].join(' ')
}

export function validateQuestPolicyDecision(
  value: unknown,
  allowedSignalIds: ReadonlySet<string>,
): QuestPolicyDecision {
  if (!isRecord(value)) throw new Error('Quest Policy output must be an object')
  if (!Array.isArray(value.candidates) || value.candidates.length < QUEST_CANDIDATE_MIN || value.candidates.length > QUEST_CANDIDATE_MAX) {
    throw new Error(`Quest Policy must produce ${QUEST_CANDIDATE_MIN}–${QUEST_CANDIDATE_MAX} candidates`)
  }
  if (!Array.isArray(value.selections) || value.selections.length < QUEST_SELECTION_MIN || value.selections.length > QUEST_SELECTION_MAX) {
    throw new Error(`Quest Policy must select ${QUEST_SELECTION_MIN}–${QUEST_SELECTION_MAX} quests`)
  }

  const seenCandidateIds = new Set<string>()
  const candidates: QuestPolicyCandidate[] = value.candidates.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Quest candidate ${index} must be an object`)
    const candidateId = nonEmptyString(raw.candidateId, `Quest candidate ${index} candidateId`)
    if (seenCandidateIds.has(candidateId)) throw new Error('Quest candidate ids must be unique')
    seenCandidateIds.add(candidateId)

    const [validated] = validateGeneratedQuestCandidates([{
      title: raw.title,
      category: raw.category,
      kind: 'side',
      difficulty: raw.difficulty,
      priority: 3,
      xp: raw.xp,
      rationale: raw.rationale,
      sourceSignalIds: raw.sourceSignalIds,
    }], allowedSignalIds)

    return {
      candidateId,
      title: validated.title,
      category: validated.category,
      difficulty: validated.difficulty,
      xp: validated.xp,
      rationale: validated.rationale,
      sourceSignalIds: signalIds(raw.sourceSignalIds, `Quest candidate ${index} sourceSignalIds`, allowedSignalIds),
      scores: scores(raw.scores, index),
    }
  })

  const candidateById = new Map(candidates.map(candidate => [candidate.candidateId, candidate]))
  const selectedIds = new Set<string>()
  const selections: QuestPolicySelection[] = value.selections.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Quest selection ${index} must be an object`)
    const candidateId = nonEmptyString(raw.candidateId, `Quest selection ${index} candidateId`)
    if (!candidateById.has(candidateId)) throw new Error(`Quest selection ${index} references a candidate outside the candidate pool`)
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

  const count = (kind: QuestKind) => selections.filter(selection => selection.kind === kind).length
  if (count('main') !== 1) throw new Error('Quest portfolio must contain exactly one Main Quest')
  if (count('side') > 2) throw new Error('Quest portfolio may contain at most two Side Quests')
  if (count('maintenance') > 1) throw new Error('Quest portfolio may contain at most one Maintenance Quest')
  if (count('bonus') > 1) throw new Error('Quest portfolio may contain at most one Bonus Quest')

  const quests = selections.map(selection => {
    const candidate = candidateById.get(selection.candidateId)!
    return {
      title: candidate.title,
      category: candidate.category,
      kind: selection.kind,
      difficulty: candidate.difficulty,
      priority: selection.priority,
      xp: candidate.xp,
      rationale: candidate.rationale,
      sourceSignalIds: candidate.sourceSignalIds,
    } satisfies GeneratedQuestCandidate
  })

  return { candidates, selections, quests }
}

export function compactQuestPolicyDecision(decision: QuestPolicyDecision) {
  return {
    version: QUEST_POLICY_VERSION,
    candidateCount: decision.candidates.length,
    candidates: decision.candidates.map(candidate => ({ id: candidate.candidateId, scores: candidate.scores })),
    selections: decision.selections.map(selection => ({
      candidateId: selection.candidateId,
      kind: selection.kind,
      priority: selection.priority,
      reason: selection.selectionReason,
    })),
  }
}
