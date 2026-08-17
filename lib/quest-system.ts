import type { Category } from './checklist-data'

export type QuestKind = 'main' | 'side' | 'maintenance' | 'bonus'
export type QuestSource = 'system' | 'legacy'

export interface DailyQuest {
  id: string
  title: string
  category: Category
  kind: QuestKind
  source: QuestSource
  xp: number
  reason?: string
}

export interface PlayerSignal {
  type: 'goal' | 'obstacle' | 'opportunity' | 'constraint' | 'relationship' | 'energy' | 'event'
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
