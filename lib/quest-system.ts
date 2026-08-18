import type { Category } from './checklist-data'

export type QuestKind = 'main' | 'side' | 'maintenance' | 'bonus'
export type QuestSource = 'system' | 'legacy' | 'ai'
export type QuestDifficulty = 'easy' | 'medium' | 'hard'
export type QuestStatus = 'pending' | 'completed' | 'partial' | 'skipped' | 'failed' | 'deferred' | 'cancelled' | 'replaced'
export type QuestPriority = 1 | 2 | 3 | 4 | 5

export interface DailyQuest {
  id: string
  title: string
  category: Category
  kind: QuestKind
  source: QuestSource
  xp: number
  reason?: string
}

export interface GeneratedQuestCandidate {
  title: string
  category: Category
  kind: QuestKind
  difficulty: QuestDifficulty
  priority: QuestPriority
  xp: number
  rationale: string
  sourceSignalIds: string[]
}

export interface PersistedDailyQuest extends GeneratedQuestCandidate {
  id: string
  userId: string
  batchId: string
  questDate: string
  source: QuestSource
  status: QuestStatus
  revision?: number
  supersedesQuestId?: string
  interruptId?: string
  materialityAssessmentId?: string
  interruptedAt?: string
  interruptReason?: string
  completedAt?: string
}

export interface PlayerSignal {
  type: 'goal' | 'obstacle' | 'opportunity' | 'constraint' | 'relationship' | 'energy' | 'event' | 'preference' | 'priority'
  summary: string
  observedAt: string
  confidence: number
}

export interface PlayerContextSnapshot {
  generatedAt: string
  summary: string
  activeGoals: string[]
  currentObstacles: string[]
  constraints: string[]
  recentSignals: PlayerSignal[]
}

export interface QuestGenerationInput {
  playerId: string
  date: string
  context: PlayerContextSnapshot
  previousQuestResults: Array<{
    questId: string
    completed: boolean
    note?: string
  }>
}

export const questKindLabel: Record<QuestKind, string> = {
  main: 'MAIN QUEST',
  side: 'SIDE QUEST',
  maintenance: 'MAINTENANCE',
  bonus: 'BONUS QUEST',
}

const CATEGORIES: Category[] = ['pagi', 'siang', 'malam', 'sepanjang_hari']
const QUEST_KINDS: QuestKind[] = ['main', 'side', 'maintenance', 'bonus']
const DIFFICULTIES: QuestDifficulty[] = ['easy', 'medium', 'hard']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sourceIds(value: unknown, index: number, allowedSignalIds?: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Quest candidate ${index} requires sourceSignalIds`)
  }

  const ids = [...new Set(value.map((item) => item.trim()))]
  if (allowedSignalIds && ids.some((id) => !allowedSignalIds.has(id))) {
    throw new Error(`Quest candidate ${index} references a signal outside retrieved context`)
  }

  return ids
}

export function validateGeneratedQuestCandidates(
  value: unknown,
  allowedSignalIds?: ReadonlySet<string>,
): GeneratedQuestCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Quest output must contain at least one candidate')
  }

  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Quest candidate ${index} must be an object`)

    const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
    const rationale = typeof candidate.rationale === 'string' ? candidate.rationale.trim() : ''
    if (!title) throw new Error(`Quest candidate ${index} requires a title`)
    if (!rationale) throw new Error(`Quest candidate ${index} requires a rationale`)
    if (!CATEGORIES.includes(candidate.category as Category)) throw new Error(`Quest candidate ${index} has invalid category`)
    if (!QUEST_KINDS.includes(candidate.kind as QuestKind)) throw new Error(`Quest candidate ${index} has invalid kind`)
    if (!DIFFICULTIES.includes(candidate.difficulty as QuestDifficulty)) throw new Error(`Quest candidate ${index} has invalid difficulty`)

    const priority = candidate.priority
    if (!Number.isInteger(priority) || Number(priority) < 1 || Number(priority) > 5) {
      throw new Error(`Quest candidate ${index} priority must be an integer from 1 to 5`)
    }

    const xp = candidate.xp
    if (!Number.isInteger(xp) || Number(xp) < 0) {
      throw new Error(`Quest candidate ${index} xp must be a non-negative integer`)
    }

    return {
      title,
      category: candidate.category as Category,
      kind: candidate.kind as QuestKind,
      difficulty: candidate.difficulty as QuestDifficulty,
      priority: priority as QuestPriority,
      xp: Number(xp),
      rationale,
      sourceSignalIds: sourceIds(candidate.sourceSignalIds, index, allowedSignalIds),
    }
  })
}

export function legacyItemToQuest(item: {
  id: string
  label: string
  category: Category
  anchor: boolean
}): DailyQuest {
  return {
    id: item.id,
    title: item.label,
    category: item.category,
    kind: item.anchor ? 'main' : 'side',
    source: 'legacy',
    xp: item.anchor ? 100 : 50,
  }
}
