import type { ActiveQuestContext, MaterialityAssessmentDecision, MaterialityContext } from './materiality'
import type { PlayerBriefSnapshot, RetrievedPlayerContext, PlayerSignal, RecentQuestResult } from './player-understanding'

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
  loadCurrentPlayerBrief(playerId: string): Promise<PlayerBriefSnapshot | null>
}

function localDateTime(now: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  return formatter.format(now).replace(' ', 'T')
}

function requireBrief(brief: PlayerBriefSnapshot | null): PlayerBriefSnapshot {
  if (!brief) throw new Error('Canonical Player Brief is missing')
  return brief
}

export class BoundedPlayerContextRetriever {
  constructor(private readonly store: PlayerContextStore) {}

  async retrieveForUnderstanding(input: {
    playerId: string
    knowledgeEntryIds: string[]
    limit: number
  }): Promise<RetrievedPlayerContext> {
    const ids = [...new Set(input.knowledgeEntryIds)].slice(0, Math.max(1, input.limit))
    const [knowledgeEntries, signals, playerBrief] = await Promise.all([
      this.store.loadKnowledgeEntries(input.playerId, ids),
      this.store.loadSignals(input.playerId, Math.min(8, input.limit)),
      this.store.loadCurrentPlayerBrief(input.playerId),
    ])

    return {
      playerId: input.playerId,
      purpose: 'understanding',
      generatedAt: new Date().toISOString(),
      playerBrief: requireBrief(playerBrief),
      knowledgeEntries,
      signals,
      recentQuestResults: [],
      activeQuests: [],
      retrieval: {
        strategy: 'canonical_player_brief_plus_explicit_knowledge_and_recent_signals',
        limit: input.limit,
        reason: 'Process selected raw knowledge against canonical current player state without scanning the full Life Vault',
      },
    }
  }

  async retrieveForUnderstandingDelta(input: {
    playerId: string
    knowledgeEntryIds: string[]
    date: string
    limit: number
  }): Promise<RetrievedPlayerContext> {
    const ids = [...new Set(input.knowledgeEntryIds)].slice(0, Math.max(1, input.limit))
    const [knowledgeEntries, signals, recentQuestResults, activeQuests, playerBrief] = await Promise.all([
      this.store.loadKnowledgeEntries(input.playerId, ids),
      this.store.loadSignals(input.playerId, Math.min(12, Math.max(8, input.limit))),
      this.store.loadRecentQuestResults(input.playerId, Math.min(8, Math.max(1, input.limit))),
      this.store.loadActiveQuests(input.playerId, input.date),
      this.store.loadCurrentPlayerBrief(input.playerId),
    ])

    return {
      playerId: input.playerId,
      purpose: 'understanding',
      generatedAt: new Date().toISOString(),
      playerBrief: requireBrief(playerBrief),
      knowledgeEntries,
      signals,
      recentQuestResults,
      activeQuests,
      retrieval: {
        strategy: 'canonical_player_brief_plus_activity_batch_and_recent_execution_context',
        limit: input.limit,
        reason: 'Derive only the state delta from new evidence while anchoring the fresh AI session to the latest canonical Player Brief',
      },
    }
  }

  async retrieveForDailyQuest(input: {
    playerId: string
    date: string
    limit: number
  }): Promise<RetrievedPlayerContext> {
    const [signals, recentQuestResults, playerBrief] = await Promise.all([
      this.store.loadSignals(input.playerId, input.limit),
      this.store.loadRecentQuestResults(input.playerId, Math.min(10, input.limit)),
      this.store.loadCurrentPlayerBrief(input.playerId),
    ])

    return {
      playerId: input.playerId,
      purpose: 'daily_quest',
      generatedAt: new Date().toISOString(),
      playerBrief: requireBrief(playerBrief),
      knowledgeEntries: [],
      signals,
      recentQuestResults,
      activeQuests: [],
      retrieval: {
        strategy: 'canonical_player_brief_plus_active_signals_and_recent_quest_results',
        limit: input.limit,
        reason: `Generate ${input.date} quests from canonical player state and derived context, never the full raw Vault`,
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
    const [knowledgeEntries, signals, recentQuestResults, activeQuests, timezone, playerBrief] = await Promise.all([
      this.store.loadKnowledgeEntries(input.playerId, [input.knowledgeEntryId]),
      this.store.loadSignals(input.playerId, input.limit),
      this.store.loadRecentQuestResults(input.playerId, Math.min(8, input.limit)),
      this.store.loadActiveQuests(input.playerId, input.date),
      this.store.loadPlayerTimezone(input.playerId),
      this.store.loadCurrentPlayerBrief(input.playerId),
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
      playerBrief: requireBrief(playerBrief),
      triggerKnowledgeEntry,
      signals,
      recentQuestResults,
      activeQuests,
      retrieval: {
        strategy: 'canonical_player_brief_plus_trigger_knowledge_active_signals_and_today_quests',
        limit: input.limit,
        reason: 'Judge whether newly understood evidence materially changes today while anchored to canonical current player state',
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
        strategy: 'canonical_player_brief_plus_material_assessment_and_current_quests',
        reason: 'Plan the smallest explicit quest revision from the latest canonical player state',
      },
    }
  }
}
