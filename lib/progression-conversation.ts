import {
  validateProgressionTarget,
  type ProgressionMapSnapshot,
  type ProgressionTargetDecision,
} from './progression-intelligence'

export const PROGRESSION_MOVE_SCHEMA_VERSION = 'progression-move.v1'
export const PROGRESSION_RESEARCH_SCHEMA_VERSION = 'progression-research.v1'
export const PROGRESSION_RESEARCH_MAX_PER_SESSION = 2
export const PLAYER_UPDATE_MAX = 2

export type ProgressionNextAction = 'ask' | 'research' | 'quest' | 'decide' | 'wait'
export type ProgressionQuestionResponseType = 'free_text' | 'short_text' | 'single_choice' | 'multiple_choice'

export interface ProgressionQuestionPlan {
  responseType: ProgressionQuestionResponseType
  prompt: string
  reason: string
  options: string[]
}

export interface ProgressionResearchPlan {
  topic: string
  question: string
  queries: string[]
  reason: string
}

export interface ProgressionResearchSource {
  title: string
  url: string
  publishedAt?: string
  keyPoint: string
}

export interface ProgressionResearchResult {
  findings: string
  sources: ProgressionResearchSource[]
}

export interface ProgressionMoveDecision {
  nextAction: ProgressionNextAction
  playerUpdates: string[]
  criticalSignalIds: string[]
  whyNow: string
  question?: ProgressionQuestionPlan
  researchPlan?: ProgressionResearchPlan
  target?: ProgressionTargetDecision
  conclusion?: string
  waitFor?: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max = 1600): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  const result = value.trim()
  if (result.length > max) throw new Error(`${label} is too long`)
  return result
}

function textArray(value: unknown, label: string, maxItems: number, maxLength = 1200): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with at most ${maxItems} items`)
  return value.map((item, index) => text(item, `${label} ${index}`, maxLength))
}

function question(value: unknown): ProgressionQuestionPlan {
  const row = record(value, 'Progression question')
  if (!['free_text', 'short_text', 'single_choice', 'multiple_choice'].includes(String(row.responseType))) {
    throw new Error('Progression question has invalid responseType')
  }
  const responseType = row.responseType as ProgressionQuestionResponseType
  const options = textArray(row.options ?? [], 'Progression question options', 6, 240)
  if ((responseType === 'single_choice' || responseType === 'multiple_choice') && options.length < 2) {
    throw new Error('Choice progression question requires at least two options')
  }
  if ((responseType === 'free_text' || responseType === 'short_text') && options.length > 0) {
    throw new Error('Text progression question cannot include choice options')
  }
  return {
    responseType,
    prompt: text(row.prompt, 'Progression question prompt', 1200),
    reason: text(row.reason, 'Progression question reason', 1600),
    options,
  }
}

function researchPlan(value: unknown): ProgressionResearchPlan {
  const row = record(value, 'Progression research plan')
  const queries = textArray(row.queries, 'Progression research queries', 4, 500)
  if (queries.length < 1) throw new Error('Progression research plan needs at least one bounded query')
  return {
    topic: text(row.topic, 'Progression research topic', 240),
    question: text(row.question, 'Progression research question', 1200),
    queries,
    reason: text(row.reason, 'Progression research reason', 1600),
  }
}

function relevantTargetSignalIds(target: ProgressionTargetDecision, map: ProgressionMapSnapshot): Set<string> {
  const ids = new Set<string>()
  const goalIds = new Set(target.primaryGoalId ? [target.primaryGoalId] : [])
  const outcomeIds = new Set(target.proximalOutcomeIds)
  const bottleneckIds = new Set(target.bottleneckIds)
  const opportunityIds = new Set(target.opportunityIds)
  for (const node of map.goals) if (goalIds.has(node.nodeId)) node.sourceSignalIds.forEach(id => ids.add(id))
  for (const node of map.proximalOutcomes) if (outcomeIds.has(node.nodeId)) node.sourceSignalIds.forEach(id => ids.add(id))
  for (const node of map.bottlenecks) if (bottleneckIds.has(node.nodeId)) node.sourceSignalIds.forEach(id => ids.add(id))
  for (const node of map.opportunities) if (opportunityIds.has(node.nodeId)) node.sourceSignalIds.forEach(id => ids.add(id))
  return ids
}

export function validateProgressionMoveDecision(
  value: unknown,
  input: {
    progressionMap: ProgressionMapSnapshot
    allowedSignalIds: ReadonlySet<string>
    requireResearch: boolean
    canQuest: boolean
    researchBudgetRemaining: number
  },
): ProgressionMoveDecision {
  const row = record(value, 'Progression move')
  if (!['ask', 'research', 'quest', 'decide', 'wait'].includes(String(row.nextAction))) {
    throw new Error('Progression move has invalid nextAction')
  }
  const nextAction = row.nextAction as ProgressionNextAction
  if (input.requireResearch && ['quest', 'decide', 'wait'].includes(nextAction)) {
    throw new Error('Initial progression decision requires external research before action')
  }
  if (!input.canQuest && nextAction === 'quest') throw new Error('Progression move cannot produce a quest before Daily Context exists')
  if (nextAction === 'research' && input.researchBudgetRemaining < 1) throw new Error('Progression research budget is exhausted for this session')

  const playerUpdates = textArray(row.playerUpdates ?? [], 'Player-facing updates', PLAYER_UPDATE_MAX, 500)
  const criticalSignalIds = textArray(row.criticalSignalIds ?? [], 'Critical signal ids', 12, 120)
  if (criticalSignalIds.some(id => !input.allowedSignalIds.has(id))) {
    throw new Error('Progression move criticalSignalIds reference evidence outside retrieved context')
  }

  const result: ProgressionMoveDecision = {
    nextAction,
    playerUpdates,
    criticalSignalIds: [...new Set(criticalSignalIds)],
    whyNow: text(row.whyNow, 'Progression move whyNow', 1200),
  }

  if (nextAction === 'ask') result.question = question(row.question)
  if (nextAction === 'research') result.researchPlan = researchPlan(row.researchPlan)
  if (nextAction === 'quest') {
    const target = validateProgressionTarget(row.target, input.progressionMap)
    const requiredIds = relevantTargetSignalIds(target, input.progressionMap)
    for (const id of requiredIds) {
      if (!result.criticalSignalIds.includes(id)) {
        throw new Error('Progression move dropped decision-relevant evidence before quest targeting')
      }
    }
    result.target = target
  }
  if (nextAction === 'decide') result.conclusion = text(row.conclusion, 'Progression decision conclusion', 1600)
  if (nextAction === 'wait') result.waitFor = text(row.waitFor, 'Progression wait condition', 1200)

  return result
}

export function validateProgressionResearchResult(value: unknown): ProgressionResearchResult {
  const row = record(value, 'Progression research result')
  if (!Array.isArray(row.sources) || row.sources.length < 1 || row.sources.length > 8) {
    throw new Error('Progression research must return 1–8 external sources')
  }
  const seen = new Set<string>()
  const sources = row.sources.map((raw, index): ProgressionResearchSource => {
    const item = record(raw, `Progression research source ${index}`)
    const url = text(item.url, `Progression research source ${index} url`, 1600)
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('Progression research source URL is invalid') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Progression research source URL must use http(s)')
    if (seen.has(url)) throw new Error('Progression research sources must be distinct')
    seen.add(url)
    return {
      title: text(item.title, `Progression research source ${index} title`, 500),
      url,
      ...(typeof item.publishedAt === 'string' && item.publishedAt.trim() ? { publishedAt: item.publishedAt.trim().slice(0, 120) } : {}),
      keyPoint: text(item.keyPoint, `Progression research source ${index} keyPoint`, 1000),
    }
  })
  return { findings: text(row.findings, 'Progression research findings', 8000), sources }
}
