import type { AiProvider } from './contracts'
import { refreshProgressionMap as refreshCoreProgressionMap } from './progression-intelligence-core'
import type { DailyQuestContextRetriever } from './orchestrator'
import type { ProgressionMapSnapshot } from '../progression-intelligence'
import type { ProgressionIntelligenceStore } from '../supabase/progression-intelligence-store'
import { shouldDeferProgressionMapForInitialization } from './player-initialization-runtime'

export async function refreshProgressionMap(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    store: ProgressionIntelligenceStore
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<ProgressionMapSnapshot> {
  const deferForInitialization = await shouldDeferProgressionMapForInitialization(input.playerId)
  if (!deferForInitialization) return refreshCoreProgressionMap(dependencies, input)

  const existing = await dependencies.store.loadCurrentProgressionMap(input.playerId)
  if (existing) return existing

  const now = new Date().toISOString()
  return {
    id: `initialization-pending:${input.playerId}`,
    version: 0,
    schemaVersion: 'progression-map.v1',
    reason: 'player_initialization_strategic_activation_deferred',
    generatedAt: now,
    createdAt: now,
    goals: [],
    proximalOutcomes: [],
    bottlenecks: [],
    opportunities: [],
    uncertainties: ['Strategic map derivation is intentionally deferred until the first post-initialization progression decision.'],
  }
}
