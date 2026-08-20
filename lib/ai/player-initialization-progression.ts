import type { AiProvider } from './contracts'
import { refreshProgressionMap as refreshCoreProgressionMap } from './progression-intelligence-core'
import type { DailyQuestContextRetriever } from './orchestrator'
import type { ProgressionMapSnapshot } from '../progression-intelligence'
import type { ProgressionIntelligenceStore } from '../supabase/progression-intelligence-store'
import { isPlayerInitializationReady } from './player-initialization-runtime'

export async function refreshProgressionMap(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    store: ProgressionIntelligenceStore
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<ProgressionMapSnapshot> {
  const ready = await isPlayerInitializationReady(input.playerId)
  if (ready) return refreshCoreProgressionMap(dependencies, input)

  const existing = await dependencies.store.loadCurrentProgressionMap(input.playerId)
  if (existing) return existing

  const now = new Date().toISOString()
  return {
    id: `initialization-pending:${input.playerId}`,
    version: 0,
    schemaVersion: 'progression-map.v1',
    reason: 'player_initialization_not_ready',
    generatedAt: now,
    createdAt: now,
    goals: [],
    proximalOutcomes: [],
    bottlenecks: [],
    opportunities: [],
    uncertainties: ['Player Initialization is not READY; strategic map derivation is intentionally deferred.'],
  }
}
