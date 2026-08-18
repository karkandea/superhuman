import type { Category } from './checklist-data'
import type { PlayerBriefSnapshot, PlayerSignal, RecentQuestResult } from './player-understanding'
import type { QuestDifficulty, QuestKind, QuestPriority, QuestStatus } from './quest-system'

export const MATERIALITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const
export const MATERIALITY_ACTIONS = ['none', 'add', 'replace', 'defer', 'cancel', 'reprioritize'] as const
export const MATERIALITY_URGENCY = ['none', 'today', 'immediate'] as const
export const INTERRUPT_ACTIONS = ['add', 'replace', 'defer', 'cancel', 'reprioritize'] as const

export type MaterialityLevel = (typeof MATERIALITY_LEVELS)[number]
export type MaterialityRecommendedAction = (typeof MATERIALITY_ACTIONS)[number]
export type MaterialityUrgency = (typeof MATERIALITY_URGENCY)[number]
export type MaterialityDisposition = 'no_change' | 'suggest' | 'auto_interrupt'
export type QuestInterruptActionType = (typeof INTERRUPT_ACTIONS)[number]
export type QuestInterruptStatus = 'suggested' | 'applied'

export interface ActiveQuestContext {
  id: string
  title: string
  category: Category
  kind: QuestKind
  difficulty: QuestDifficulty
  priority: QuestPriority
  xp: number
  rationale: string
  status: QuestStatus
  source: 'ai' | 'system' | 'legacy'
  completedAt?: string
}

export interface MaterialityContext {
  playerId: string
  purpose: 'materiality' | 'system_interrupt'
  generatedAt: string
  targetDate: string
  playerTimezone: string
  localDateTime: string
  playerBrief?: PlayerBriefSnapshot
  triggerKnowledgeEntry: {
    id: string
    type: string
    text: string
    occurredAt?: string
  }
  signals: PlayerSignal[]
  recentQuestResults: RecentQuestResult[]
  activeQuests: ActiveQuestContext[]
  materialityAssessment?: MaterialityAssessmentDecision
  retrieval: {
    strategy: string
    limit: number
    reason: string
  }
}

export interface MaterialityAssessmentDecision {
  isMaterial: boolean
  level: MaterialityLevel
  confidence: number
  reason: string
  affectedQuestIds: string[]
  sourceSignalIds: string[]
  recommendedAction: MaterialityRecommendedAction
  urgency: MaterialityUrgency
}

export interface PersistedMaterialityAssessment extends MaterialityAssessmentDecision {
  id: string
  userId: string
  knowledgeEntryId: string
  targetDate: string
  disposition: MaterialityDisposition
  createdAt: string
}

export interface InterruptQuestCandidate {
  title: string
  category: Category
  kind: QuestKind
  difficulty: QuestDifficulty
  priority: QuestPriority
  xp: number
  rationale: string
  sourceSignalIds: string[]
}

export interface QuestInterruptActionCandidate {
  action: QuestInterruptActionType
  targetQuestId?: string
  newPriority?: QuestPriority
  quest?: InterruptQuestCandidate
  reason: string
}

export interface QuestInterruptPlan {
  summary: string
  actions: QuestInterruptActionCandidate[]
}

export interface PersistedQuestInterrupt {
  id: string
  userId: string
  assessmentId: string
  questDate: string
  status: QuestInterruptStatus
  summary: string
  createdAt: string
  appliedAt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uniqueIds(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of ids`)
  }
  const ids = [...new Set(value.map((item) => String(item).trim()))]
  if (!allowEmpty && ids.length === 0) throw new Error(`${field} must contain at least one id`)
  return ids
}

function questCandidate(value: unknown, index: number, allowedSignalIds: ReadonlySet<string>): InterruptQuestCandidate {
  if (!isRecord(value)) throw new Error(`Interrupt action ${index} quest must be an object`)
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  const rationale = typeof value.rationale === 'string' ? value.rationale.trim() : ''
  if (!title || !rationale) throw new Error(`Interrupt action ${index} quest requires title and rationale`)
  if (!['pagi', 'siang', 'malam', 'sepanjang_hari'].includes(String(value.category))) throw new Error(`Interrupt action ${index} quest category is invalid`)
  if (!['main', 'side', 'maintenance', 'bonus'].includes(String(value.kind))) throw new Error(`Interrupt action ${index} quest kind is invalid`)
  if (!['easy', 'medium', 'hard'].includes(String(value.difficulty))) throw new Error(`Interrupt action ${index} quest difficulty is invalid`)
  if (!Number.isInteger(value.priority) || Number(value.priority) < 1 || Number(value.priority) > 5) throw new Error(`Interrupt action ${index} quest priority is invalid`)
  if (!Number.isInteger(value.xp) || Number(value.xp) < 0) throw new Error(`Interrupt action ${index} quest xp is invalid`)
  const sourceSignalIds = uniqueIds(value.sourceSignalIds, `Interrupt action ${index} sourceSignalIds`)
  if (sourceSignalIds.some((id) => !allowedSignalIds.has(id))) throw new Error(`Interrupt action ${index} references a signal outside retrieved context`)
  return {
    title,
    category: value.category as Category,
    kind: value.kind as QuestKind,
    difficulty: value.difficulty as QuestDifficulty,
    priority: Number(value.priority) as QuestPriority,
    xp: Number(value.xp),
    rationale,
    sourceSignalIds,
  }
}

export function validateMaterialityAssessment(
  value: unknown,
  allowedQuestIds: ReadonlySet<string>,
  allowedSignalIds: ReadonlySet<string>,
): MaterialityAssessmentDecision {
  if (!isRecord(value)) throw new Error('Materiality assessment must be an object')
  if (typeof value.isMaterial !== 'boolean') throw new Error('Materiality assessment isMaterial must be boolean')
  if (!MATERIALITY_LEVELS.includes(value.level as MaterialityLevel)) throw new Error('Materiality assessment level is invalid')
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error('Materiality assessment confidence must be between 0 and 1')
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  if (!reason) throw new Error('Materiality assessment reason is required')
  const affectedQuestIds = uniqueIds(value.affectedQuestIds, 'Materiality assessment affectedQuestIds', true)
  if (affectedQuestIds.some((id) => !allowedQuestIds.has(id))) throw new Error('Materiality assessment references quest outside active context')
  const sourceSignalIds = uniqueIds(value.sourceSignalIds, 'Materiality assessment sourceSignalIds', true)
  if (sourceSignalIds.some((id) => !allowedSignalIds.has(id))) throw new Error('Materiality assessment references signal outside retrieved context')
  if (!MATERIALITY_ACTIONS.includes(value.recommendedAction as MaterialityRecommendedAction)) throw new Error('Materiality assessment recommendedAction is invalid')
  if (!MATERIALITY_URGENCY.includes(value.urgency as MaterialityUrgency)) throw new Error('Materiality assessment urgency is invalid')

  if (!value.isMaterial && value.recommendedAction !== 'none') throw new Error('Non-material assessment must recommend no action')
  if (value.recommendedAction === 'none' && affectedQuestIds.length > 0) throw new Error('No-action assessment must not target quests')
  if (value.recommendedAction !== 'none' && value.recommendedAction !== 'add' && affectedQuestIds.length === 0) throw new Error('Quest-changing assessment must identify affected quests')

  return {
    isMaterial: value.isMaterial,
    level: value.level as MaterialityLevel,
    confidence: value.confidence,
    reason,
    affectedQuestIds,
    sourceSignalIds,
    recommendedAction: value.recommendedAction as MaterialityRecommendedAction,
    urgency: value.urgency as MaterialityUrgency,
  }
}

export function materialityDisposition(decision: MaterialityAssessmentDecision): MaterialityDisposition {
  if (!decision.isMaterial || decision.recommendedAction === 'none') return 'no_change'
  if ((decision.level === 'high' || decision.level === 'critical') && decision.confidence >= 0.85 && (decision.urgency === 'today' || decision.urgency === 'immediate')) {
    return 'auto_interrupt'
  }
  return 'suggest'
}

export function validateQuestInterruptPlan(
  value: unknown,
  allowedQuestIds: ReadonlySet<string>,
  allowedSignalIds: ReadonlySet<string>,
): QuestInterruptPlan {
  if (!isRecord(value)) throw new Error('Interrupt plan must be an object')
  const summary = typeof value.summary === 'string' ? value.summary.trim() : ''
  if (!summary) throw new Error('Interrupt plan summary is required')
  if (!Array.isArray(value.actions) || value.actions.length === 0) throw new Error('Interrupt plan requires at least one action')

  const actions = value.actions.map((rawAction, index) => {
    if (!isRecord(rawAction)) throw new Error(`Interrupt action ${index} must be an object`)
    if (!INTERRUPT_ACTIONS.includes(rawAction.action as QuestInterruptActionType)) throw new Error(`Interrupt action ${index} type is invalid`)
    const action = rawAction.action as QuestInterruptActionType
    const reason = typeof rawAction.reason === 'string' ? rawAction.reason.trim() : ''
    if (!reason) throw new Error(`Interrupt action ${index} reason is required`)

    let targetQuestId: string | undefined
    if (action !== 'add') {
      targetQuestId = typeof rawAction.targetQuestId === 'string' ? rawAction.targetQuestId.trim() : ''
      if (!targetQuestId || !allowedQuestIds.has(targetQuestId)) throw new Error(`Interrupt action ${index} target quest is invalid`)
    }

    let newPriority: QuestPriority | undefined
    if (action === 'reprioritize') {
      if (!Number.isInteger(rawAction.newPriority) || Number(rawAction.newPriority) < 1 || Number(rawAction.newPriority) > 5) throw new Error(`Interrupt action ${index} newPriority is invalid`)
      newPriority = Number(rawAction.newPriority) as QuestPriority
    }

    let quest: InterruptQuestCandidate | undefined
    if (action === 'add' || action === 'replace') quest = questCandidate(rawAction.quest, index, allowedSignalIds)

    return {
      action,
      ...(targetQuestId ? { targetQuestId } : {}),
      ...(newPriority ? { newPriority } : {}),
      ...(quest ? { quest } : {}),
      reason,
    }
  })

  return { summary, actions }
}
