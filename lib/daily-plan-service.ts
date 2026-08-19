import type { SupabaseClient } from '@supabase/supabase-js'

export interface DailyPlanState {
  finalized: boolean
  noQuest: boolean
  noQuestReason?: string
  progressionTargetId?: string
  progressionTargetSummary?: string
  progressionTargetMode?: 'progress' | 'maintenance_only' | 'no_intervention'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function getDailyPlanState(
  client: SupabaseClient,
  playerId: string,
  date: string,
): Promise<DailyPlanState> {
  const { data: batch, error: batchError } = await client
    .from('quest_batches')
    .select('status,generation_metadata,progression_target_id')
    .eq('user_id', playerId)
    .eq('quest_date', date)
    .maybeSingle()
  if (batchError) throw new Error(batchError.message)
  if (!batch || batch.status !== 'generated') return { finalized: false, noQuest: false }

  const metadata = asRecord(batch.generation_metadata)
  const progressionTargetId = batch.progression_target_id ? String(batch.progression_target_id) : undefined
  let progressionTargetSummary: string | undefined
  let progressionTargetMode: DailyPlanState['progressionTargetMode']

  if (progressionTargetId) {
    const { data: target, error: targetError } = await client
      .from('progression_targets')
      .select('decision')
      .eq('id', progressionTargetId)
      .eq('user_id', playerId)
      .maybeSingle()
    if (targetError) throw new Error(targetError.message)
    const decision = asRecord(target?.decision)
    if (typeof decision.summary === 'string' && decision.summary.trim()) progressionTargetSummary = decision.summary.trim()
    if (['progress', 'maintenance_only', 'no_intervention'].includes(String(decision.mode))) {
      progressionTargetMode = decision.mode as DailyPlanState['progressionTargetMode']
    }
  }

  return {
    finalized: true,
    noQuest: metadata.noQuest === true,
    ...(typeof metadata.noQuestReason === 'string' && metadata.noQuestReason.trim() ? { noQuestReason: metadata.noQuestReason.trim() } : {}),
    ...(progressionTargetId ? { progressionTargetId } : {}),
    ...(progressionTargetSummary ? { progressionTargetSummary } : {}),
    ...(progressionTargetMode ? { progressionTargetMode } : {}),
  }
}
