import type { DailyContextSnapshot } from './daily-context'
import type { PlayerBriefSnapshot, PlayerSignal, RecentQuestResult } from './player-understanding'

export const PROGRESSION_MAP_VERSION = 'progression-map.v1'
export const PLAYER_RESPONSE_MODEL_VERSION = 'player-response-model.v1'
export const PROGRESSION_TARGET_VERSION = 'progression-target.v1'
export const QUEST_RESPONSE_REVIEW_VERSION = 'quest-response.v1'

export const EFFECTIVENESS_LEVELS = ['unknown', 'none', 'weak', 'moderate', 'strong'] as const
export type EffectivenessLevel = (typeof EFFECTIVENESS_LEVELS)[number]

export interface ProgressionGoalNode {
  nodeId: string
  summary: string
  priority: number
  confidence: number
  sourceSignalIds: string[]
}

export interface ProximalOutcomeNode {
  nodeId: string
  goalId: string
  summary: string
  importance: number
  confidence: number
  sourceSignalIds: string[]
}

export interface ProgressionDriverNode {
  nodeId: string
  outcomeIds: string[]
  summary: string
  importance: number
  confidence: number
  sourceSignalIds: string[]
}

export interface ProgressionMapBody {
  goals: ProgressionGoalNode[]
  proximalOutcomes: ProximalOutcomeNode[]
  bottlenecks: ProgressionDriverNode[]
  opportunities: ProgressionDriverNode[]
  uncertainties: string[]
}

export interface ProgressionMapSnapshot extends ProgressionMapBody {
  id: string
  version: number
  schemaVersion: string
  reason: string
  generatedAt: string
  createdAt: string
}

export interface QuestStrategicChain {
  goalId?: string
  proximalOutcomeId?: string
  driverType: 'bottleneck' | 'opportunity' | 'maintenance'
  driverId?: string
  causalReason: string
}

export interface QuestExecutionContract {
  action: string
  completionCondition: string
  appropriateContext: string
  dose: string
}

export interface QuestFeasibilityAssessment {
  feasibleToday: boolean
  receptivity: 'low' | 'medium' | 'high' | 'unknown'
  estimatedMinutes: number
  reason: string
}

export interface QuestResponseEvent {
  id: string
  questId: string
  questDate: string
  title: string
  kind: string
  difficulty: string
  outcome: 'completed' | 'partial' | 'skipped' | 'failed'
  note?: string
  strategicChain?: QuestStrategicChain
  executionContract?: QuestExecutionContract
  dailyContext?: {
    mode: 'normal' | 'context'
    text: string
  }
  inferredBarrier?: string
  effectiveness: EffectivenessLevel
  effectivenessReason: string
  evidenceSignalIds: string[]
  reviewedAt?: string
}

export interface ResponsePattern {
  patternId: string
  observation: string
  confidence: number
  evidenceQuestIds: string[]
  preferredAdjustment: string
}

export interface StrategyEvidence {
  evidenceId: string
  strategicDriver: string
  effectiveness: EffectivenessLevel
  confidence: number
  evidenceQuestIds: string[]
  reason: string
}

export interface PlayerResponseModelBody {
  executionPatterns: ResponsePattern[]
  difficultyCalibration: ResponsePattern[]
  receptivityPatterns: ResponsePattern[]
  strategyEvidence: StrategyEvidence[]
  uncertainties: string[]
}

export interface PlayerResponseModelSnapshot extends PlayerResponseModelBody {
  id: string
  version: number
  schemaVersion: string
  reason: string
  generatedAt: string
  createdAt: string
}

export interface ProgressionTargetDecision {
  mode: 'progress' | 'maintenance_only' | 'no_intervention'
  summary: string
  primaryGoalId?: string
  proximalOutcomeIds: string[]
  bottleneckIds: string[]
  opportunityIds: string[]
  maintenanceIntent?: string
  maxQuestCount: number
  rationale: string
  noQuestReason?: string
}

export interface ProgressionTargetSnapshot extends ProgressionTargetDecision {
  id: string
  userId: string
  targetDate: string
  progressionMapId: string
  playerResponseModelId?: string
  dailyContextId: string
  schemaVersion: string
  createdAt: string
}

export interface QuestResponseReview {
  questId: string
  inferredBarrier?: string
  effectiveness: EffectivenessLevel
  effectivenessReason: string
  evidenceSignalIds: string[]
  confidence: number
}

export interface ProgressionIntelligenceContext {
  playerId: string
  date: string
  generatedAt: string
  playerBrief: PlayerBriefSnapshot
  dailyContext?: DailyContextSnapshot | null
  signals: PlayerSignal[]
  recentQuestResults: RecentQuestResult[]
  questResponses: QuestResponseEvent[]
  progressionMap?: ProgressionMapSnapshot | null
  playerResponseModel?: PlayerResponseModelSnapshot | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, field: string, max = 1200) {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result) throw new Error(`${field} must be a non-empty string`)
  if (result.length > max) throw new Error(`${field} is too long`)
  return result
}

function optionalText(value: unknown, field: string, max = 1200) {
  if (value === undefined || value === null || value === '') return undefined
  return text(value, field, max)
}

function boundedInt(value: unknown, field: string, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`)
  }
  return Number(value)
}

function confidence(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`)
  }
  return value
}

function ids(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; allowed?: ReadonlySet<string> } = {},
) {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new Error(`${field} must be ${options.allowEmpty ? 'an' : 'a non-empty'} array`)
  }
  if (value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must contain non-empty ids`)
  }
  const result = [...new Set(value.map(item => String(item).trim()))]
  if (options.allowed && result.some(id => !options.allowed!.has(id))) {
    throw new Error(`${field} references ids outside bounded context`)
  }
  return result
}

function stringList(value: unknown, field: string, maxItems = 12) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must be a bounded array`)
  return value.map((item, index) => text(item, `${field}[${index}]`, 500))
}

function nodeId(value: unknown, field: string, seen: Set<string>) {
  const id = text(value, field, 120)
  if (seen.has(id)) throw new Error(`Progression Map node ids must be unique: ${id}`)
  seen.add(id)
  return id
}

export function validateProgressionMap(
  value: unknown,
  allowedSignalIds: ReadonlySet<string>,
): ProgressionMapBody {
  if (!isRecord(value)) throw new Error('Progression Map output must be an object')
  const seen = new Set<string>()

  const rawGoals = Array.isArray(value.goals) ? value.goals : []
  if (rawGoals.length > 8) throw new Error('Progression Map goals must stay bounded')
  const goals = rawGoals.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Progression goal ${index} must be an object`)
    return {
      nodeId: nodeId(raw.nodeId, `Progression goal ${index} nodeId`, seen),
      summary: text(raw.summary, `Progression goal ${index} summary`),
      priority: boundedInt(raw.priority, `Progression goal ${index} priority`, 1, 5),
      confidence: confidence(raw.confidence, `Progression goal ${index} confidence`),
      sourceSignalIds: ids(raw.sourceSignalIds, `Progression goal ${index} sourceSignalIds`, { allowed: allowedSignalIds }),
    }
  })
  const goalIds = new Set(goals.map(goal => goal.nodeId))

  const rawOutcomes = Array.isArray(value.proximalOutcomes) ? value.proximalOutcomes : []
  if (rawOutcomes.length > 16) throw new Error('Progression Map proximal outcomes must stay bounded')
  const proximalOutcomes = rawOutcomes.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Proximal outcome ${index} must be an object`)
    const goalId = text(raw.goalId, `Proximal outcome ${index} goalId`, 120)
    if (!goalIds.has(goalId)) throw new Error(`Proximal outcome ${index} references an unknown goal`)
    return {
      nodeId: nodeId(raw.nodeId, `Proximal outcome ${index} nodeId`, seen),
      goalId,
      summary: text(raw.summary, `Proximal outcome ${index} summary`),
      importance: boundedInt(raw.importance, `Proximal outcome ${index} importance`, 1, 5),
      confidence: confidence(raw.confidence, `Proximal outcome ${index} confidence`),
      sourceSignalIds: ids(raw.sourceSignalIds, `Proximal outcome ${index} sourceSignalIds`, { allowed: allowedSignalIds }),
    }
  })
  const outcomeIds = new Set(proximalOutcomes.map(outcome => outcome.nodeId))

  const mapDrivers = (rawValue: unknown, label: string) => {
    const rawDrivers = Array.isArray(rawValue) ? rawValue : []
    if (rawDrivers.length > 16) throw new Error(`Progression Map ${label} must stay bounded`)
    return rawDrivers.map((raw, index) => {
      if (!isRecord(raw)) throw new Error(`${label} ${index} must be an object`)
      return {
        nodeId: nodeId(raw.nodeId, `${label} ${index} nodeId`, seen),
        outcomeIds: ids(raw.outcomeIds, `${label} ${index} outcomeIds`, { allowed: outcomeIds }),
        summary: text(raw.summary, `${label} ${index} summary`),
        importance: boundedInt(raw.importance, `${label} ${index} importance`, 1, 5),
        confidence: confidence(raw.confidence, `${label} ${index} confidence`),
        sourceSignalIds: ids(raw.sourceSignalIds, `${label} ${index} sourceSignalIds`, { allowed: allowedSignalIds }),
      }
    })
  }

  return {
    goals,
    proximalOutcomes,
    bottlenecks: mapDrivers(value.bottlenecks, 'Bottleneck'),
    opportunities: mapDrivers(value.opportunities, 'Opportunity'),
    uncertainties: stringList(value.uncertainties ?? [], 'Progression Map uncertainties'),
  }
}

export function validateQuestResponseReviews(
  value: unknown,
  allowedQuestIds: ReadonlySet<string>,
  allowedSignalIds: ReadonlySet<string>,
): QuestResponseReview[] {
  if (!Array.isArray(value)) throw new Error('Quest response review output must be an array')
  const touched = new Set<string>()
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Quest response review ${index} must be an object`)
    const questId = text(raw.questId, `Quest response review ${index} questId`, 120)
    if (!allowedQuestIds.has(questId)) throw new Error(`Quest response review ${index} references a quest outside bounded context`)
    if (touched.has(questId)) throw new Error('Quest response review may update each quest only once')
    touched.add(questId)
    if (!EFFECTIVENESS_LEVELS.includes(raw.effectiveness as EffectivenessLevel)) {
      throw new Error(`Quest response review ${index} has invalid effectiveness`)
    }
    const evidenceSignalIds = ids(raw.evidenceSignalIds ?? [], `Quest response review ${index} evidenceSignalIds`, {
      allowEmpty: true,
      allowed: allowedSignalIds,
    })
    if (raw.effectiveness !== 'unknown' && evidenceSignalIds.length === 0) {
      throw new Error(`Quest response review ${index} cannot claim effectiveness without downstream signal evidence`)
    }
    return {
      questId,
      ...(optionalText(raw.inferredBarrier, `Quest response review ${index} inferredBarrier`) ? {
        inferredBarrier: optionalText(raw.inferredBarrier, `Quest response review ${index} inferredBarrier`),
      } : {}),
      effectiveness: raw.effectiveness as EffectivenessLevel,
      effectivenessReason: text(raw.effectivenessReason, `Quest response review ${index} effectivenessReason`),
      evidenceSignalIds,
      confidence: confidence(raw.confidence, `Quest response review ${index} confidence`),
    }
  })
}

function validatePattern(
  raw: unknown,
  label: string,
  index: number,
  allowedQuestIds: ReadonlySet<string>,
): ResponsePattern {
  if (!isRecord(raw)) throw new Error(`${label} ${index} must be an object`)
  return {
    patternId: text(raw.patternId, `${label} ${index} patternId`, 120),
    observation: text(raw.observation, `${label} ${index} observation`),
    confidence: confidence(raw.confidence, `${label} ${index} confidence`),
    evidenceQuestIds: ids(raw.evidenceQuestIds, `${label} ${index} evidenceQuestIds`, { allowed: allowedQuestIds }),
    preferredAdjustment: text(raw.preferredAdjustment, `${label} ${index} preferredAdjustment`),
  }
}

export function validatePlayerResponseModel(
  value: unknown,
  allowedQuestIds: ReadonlySet<string>,
): PlayerResponseModelBody {
  if (!isRecord(value)) throw new Error('Player Response Model output must be an object')
  const boundedPatterns = (raw: unknown, label: string) => {
    const items = Array.isArray(raw) ? raw : []
    if (items.length > 12) throw new Error(`${label} must stay bounded`)
    return items.map((item, index) => validatePattern(item, label, index, allowedQuestIds))
  }
  const rawStrategy = Array.isArray(value.strategyEvidence) ? value.strategyEvidence : []
  if (rawStrategy.length > 12) throw new Error('Strategy evidence must stay bounded')
  const strategyEvidence = rawStrategy.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Strategy evidence ${index} must be an object`)
    if (!EFFECTIVENESS_LEVELS.includes(raw.effectiveness as EffectivenessLevel)) {
      throw new Error(`Strategy evidence ${index} has invalid effectiveness`)
    }
    return {
      evidenceId: text(raw.evidenceId, `Strategy evidence ${index} evidenceId`, 120),
      strategicDriver: text(raw.strategicDriver, `Strategy evidence ${index} strategicDriver`),
      effectiveness: raw.effectiveness as EffectivenessLevel,
      confidence: confidence(raw.confidence, `Strategy evidence ${index} confidence`),
      evidenceQuestIds: ids(raw.evidenceQuestIds, `Strategy evidence ${index} evidenceQuestIds`, { allowed: allowedQuestIds }),
      reason: text(raw.reason, `Strategy evidence ${index} reason`),
    }
  })

  return {
    executionPatterns: boundedPatterns(value.executionPatterns, 'Execution pattern'),
    difficultyCalibration: boundedPatterns(value.difficultyCalibration, 'Difficulty calibration'),
    receptivityPatterns: boundedPatterns(value.receptivityPatterns, 'Receptivity pattern'),
    strategyEvidence,
    uncertainties: stringList(value.uncertainties ?? [], 'Player Response Model uncertainties'),
  }
}

export function validateProgressionTarget(
  value: unknown,
  map: ProgressionMapSnapshot,
): ProgressionTargetDecision {
  if (!isRecord(value)) throw new Error('Progression Target output must be an object')
  if (!['progress', 'maintenance_only', 'no_intervention'].includes(String(value.mode))) {
    throw new Error('Progression Target has invalid mode')
  }
  const mode = value.mode as ProgressionTargetDecision['mode']
  const goalIds = new Set(map.goals.map(goal => goal.nodeId))
  const outcomeIds = new Set(map.proximalOutcomes.map(outcome => outcome.nodeId))
  const bottleneckIds = new Set(map.bottlenecks.map(driver => driver.nodeId))
  const opportunityIds = new Set(map.opportunities.map(driver => driver.nodeId))
  const primaryGoalId = optionalText(value.primaryGoalId, 'Progression Target primaryGoalId', 120)
  if (primaryGoalId && !goalIds.has(primaryGoalId)) throw new Error('Progression Target references an unknown goal')

  const decision: ProgressionTargetDecision = {
    mode,
    summary: text(value.summary, 'Progression Target summary'),
    ...(primaryGoalId ? { primaryGoalId } : {}),
    proximalOutcomeIds: ids(value.proximalOutcomeIds ?? [], 'Progression Target proximalOutcomeIds', { allowEmpty: true, allowed: outcomeIds }),
    bottleneckIds: ids(value.bottleneckIds ?? [], 'Progression Target bottleneckIds', { allowEmpty: true, allowed: bottleneckIds }),
    opportunityIds: ids(value.opportunityIds ?? [], 'Progression Target opportunityIds', { allowEmpty: true, allowed: opportunityIds }),
    ...(optionalText(value.maintenanceIntent, 'Progression Target maintenanceIntent') ? {
      maintenanceIntent: optionalText(value.maintenanceIntent, 'Progression Target maintenanceIntent'),
    } : {}),
    maxQuestCount: boundedInt(value.maxQuestCount, 'Progression Target maxQuestCount', 0, 5),
    rationale: text(value.rationale, 'Progression Target rationale'),
    ...(optionalText(value.noQuestReason, 'Progression Target noQuestReason') ? {
      noQuestReason: optionalText(value.noQuestReason, 'Progression Target noQuestReason'),
    } : {}),
  }

  if (mode === 'no_intervention') {
    if (decision.maxQuestCount !== 0) throw new Error('No-intervention target must have maxQuestCount 0')
    if (!decision.noQuestReason) throw new Error('No-intervention target requires noQuestReason')
    return decision
  }

  if (decision.maxQuestCount < 1) throw new Error('Active progression target must allow at least one quest')
  if (mode === 'progress') {
    if (!decision.primaryGoalId) throw new Error('Progress target requires a primary goal')
    if (decision.proximalOutcomeIds.length === 0) throw new Error('Progress target requires a proximal outcome')
    if (decision.bottleneckIds.length === 0 && decision.opportunityIds.length === 0) {
      throw new Error('Progress target requires a bottleneck or opportunity driver')
    }
  }
  return decision
}

export function compactProgressionMap(map: ProgressionMapSnapshot) {
  return {
    id: map.id,
    version: map.version,
    schemaVersion: map.schemaVersion,
    goals: map.goals,
    proximalOutcomes: map.proximalOutcomes,
    bottlenecks: map.bottlenecks,
    opportunities: map.opportunities,
    uncertainties: map.uncertainties,
  }
}

export function compactPlayerResponseModel(model: PlayerResponseModelSnapshot | null | undefined) {
  if (!model) return null
  return {
    id: model.id,
    version: model.version,
    schemaVersion: model.schemaVersion,
    executionPatterns: model.executionPatterns,
    difficultyCalibration: model.difficultyCalibration,
    receptivityPatterns: model.receptivityPatterns,
    strategyEvidence: model.strategyEvidence,
    uncertainties: model.uncertainties,
  }
}
