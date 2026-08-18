import type { ActiveQuestContext, MaterialityAssessmentDecision, MaterialityContext } from './materiality'
import type { RetrievedPlayerContext, PlayerSignal, RecentQuestResult } from './player-understanding'

export interface ContextKnowledgeEntry {
  id: string
  type: string
  text: string
  occurredAt?: string
}

export interface PlayerContextStore {
  loadKnowledgeEntries(playerId: string, ids: string[]): Promise<ContextKnowledgeEntry[]>
  loadSignals(playerId: string, limit: number): Promise<PlayerSignal[]>
  loadRecentQuestResults(playerId: string, limit: number): Promise<RecentQuestResult[]>
  loadActiveQuests(playerId: string, date: string): Promise<ActiveQuestContext[]>
  loadPlayerTimezone(playerId: string): Promise<string>
}

function localDateTime(now: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  return formatter.format(now).replace(' ', 'T')
}

export class BoundedPlayerContextRetriever {
  constructor(private readonly store: PlayerContextStore) {}

  async retrieveForUnderstanding(input: {
    playerId: string
    knowledgeEntryIds: string[]
    limit: number
  }): Promise<RetrievedPlayerContext> {
    const ids = [...new Set(input.knowledgeEntryIds)].slice(0, Math.max(1, input.limit))
    const [knowledgeEntries, signals] = await Promise.all([
      this.store.loadKnowledgeEntries(input.playerId, ids),
      this.store.loadSignals(input.playerId, Math.min(8, input.limit)),
    ])

    return {
      playerId: input.playerId,
      purpose: 'understanding',
      generatedAt: new Date().toISOString(),
      knowledgeEntries,
      signals,
      recentQuestResults: [],
      retrieval: {
        strategy: 'explicit_knowledge_plus_recent_signals',
        limit: input.limit,
        reason: 'Process selected raw knowledge without scanning the full Life Vault',
      },
    }
  }

  async retrieveForDailyQuest(input: {
    playerId: string
    date: string
    limit: number
  }): Promise<RetrievedPlayerContext> {
    const [signals, recentQuestResults] = await Promise.all([
      this.store.loadSignals(input.playerId, input.limit),
      this.store.loadRecentQuestResults(input.playerId, Math.min(10, input.limit)),
    ])

    return {
      playerId: input.playerId,
      purpose: 'daily_quest',
      generatedAt: new Date().toISOString(),
      knowledgeEntries: [],
      signals,
      recentQuestResults,
      retrieval: {
        strategy: 'active_signals_plus_recent_quest_results',
        limit: input.limit,
        reason: `Generate ${input.date} quests from derived context, not the full raw Vault`,
      },
    }
  }

  async retrieveForMateriality(input: {
    playerId: string
    knowledgeEntryId: string
    date: string
    limit: number
    now?: Date
  }): Promise<MaterialityContext> {
    const now = input.now ?? new Date()
    const [knowledgeEntries, signals, recentQuestResults, activeQuests, timezone] = await Promise.all([
      this.store.loadKnowledgeEntries(input.playerId, [input.knowledgeEntryId]),
      this.store.loadSignals(input.playerId, input.limit),
      this.store.loadRecentQuestResults(input.playerId, Math.min(8, input.limit)),
      this.store.loadActiveQuests(input.playerId, input.date),
      this.store.loadPlayerTimezone(input.playerId),
    ])
    const triggerKnowledgeEntry = knowledgeEntries[0]
    if (!triggerKnowledgeEntry) throw new Error('Materiality trigger knowledge was not retrieved')

    return {
      playerId: input.playerId,
      purpose: 'materiality',
      generatedAt: now.toISOString(),
      targetDate: input.date,
      playerTimezone: timezone,
      localDateTime: localDateTime(now, timezone),
      triggerKnowledgeEntry,
      signals,
      recentQuestResults,
      activeQuests,
      retrieval: {
        strategy: 'trigger_knowledge_plus_active_signals_and_today_quests',
        limit: input.limit,
        reason: 'Judge whether one newly understood update materially changes today without regenerating the whole day',
      },
    }
  }

  async retrieveForSystemInterrupt(input: {
    playerId: string
    knowledgeEntryId: string
    date: string
    assessment: MaterialityAssessmentDecision
    limit: number
    now?: Date
  }): Promise<MaterialityContext> {
    const context = await this.retrieveForMateriality(input)
    return {
      ...context,
      purpose: 'system_interrupt',
      materialityAssessment: input.assessment,
      retrieval: {
        ...context.retrieval,
        strategy: 'material_assessment_plus_current_quests',
        reason: 'Plan the smallest explicit quest revision required by the persisted material update',
      },
    }
  }
}
