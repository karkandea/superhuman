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
}
