import type { AiProvider } from './contracts'
import type { DailyQuestContextRetriever } from './orchestrator'
import type { ProgressionTargetSnapshot } from '../progression-intelligence'
import type { ProgressionIntelligenceStore } from '../supabase/progression-intelligence-store'
import { chooseProgressionTarget as chooseProgressionTargetCore } from './progression-conversation-intelligence-core'
import { withProgressionTargetDomainRepair } from './progression-target-domain-repair'

export async function chooseProgressionTarget(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    store: ProgressionIntelligenceStore
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<ProgressionTargetSnapshot> {
  return chooseProgressionTargetCore({
    ...dependencies,
    provider: withProgressionTargetDomainRepair(dependencies.provider),
  }, input)
}
