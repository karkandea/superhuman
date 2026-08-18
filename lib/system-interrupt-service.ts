import type { SupabaseClient } from '@supabase/supabase-js'
import type { MaterialityLevel, MaterialityRecommendedAction, MaterialityUrgency, QuestInterruptActionType, QuestInterruptStatus } from './materiality'

export interface TodayInterruptAction {
  id: string
  action: QuestInterruptActionType
  reason: string
  targetQuestId?: string
  targetQuestTitle?: string
  resultQuestId?: string
  resultQuestTitle?: string
  newPriority?: number
}

export interface TodayInterrupt {
  id: string
  status: QuestInterruptStatus
  summary: string
  createdAt: string
  appliedAt?: string
  assessment: {
    reason: string
    level: MaterialityLevel
    confidence: number
    urgency: MaterialityUrgency
    recommendedAction: MaterialityRecommendedAction
  }
  actions: TodayInterruptAction[]
}

function fail(error: { message: string } | null, operation: string) {
  if (error) throw new Error(`${operation}: ${error.message}`)
}

export async function loadTodayInterrupts(
  client: SupabaseClient,
  playerId: string,
  date: string,
): Promise<TodayInterrupt[]> {
  const { data: interruptRows, error: interruptError } = await client
    .from('quest_interrupts')
    .select('id,assessment_id,status,summary,created_at,applied_at')
    .eq('user_id', playerId)
    .eq('quest_date', date)
    .order('created_at', { ascending: false })
  fail(interruptError, 'load today interrupts')
  if (!interruptRows?.length) return []

  const interruptIds = interruptRows.map((row) => row.id)
  const assessmentIds = interruptRows.map((row) => row.assessment_id)
  const [{ data: assessmentRows, error: assessmentError }, { data: actionRows, error: actionError }] = await Promise.all([
    client
      .from('materiality_assessments')
      .select('id,reason,level,confidence,urgency,recommended_action')
      .eq('user_id', playerId)
      .in('id', assessmentIds),
    client
      .from('quest_interrupt_actions')
      .select('id,interrupt_id,ordinal,action,target_quest_id,result_quest_id,new_priority,reason')
      .eq('user_id', playerId)
      .in('interrupt_id', interruptIds)
      .order('ordinal', { ascending: true }),
  ])
  fail(assessmentError, 'load interrupt materiality')
  fail(actionError, 'load interrupt actions')

  const questIds = [...new Set((actionRows ?? []).flatMap((row) => [row.target_quest_id, row.result_quest_id]).filter(Boolean))]
  let questTitles = new Map<string, string>()
  if (questIds.length > 0) {
    const { data: questRows, error: questError } = await client
      .from('daily_quests')
      .select('id,title')
      .eq('user_id', playerId)
      .in('id', questIds)
    fail(questError, 'load interrupt quest titles')
    questTitles = new Map((questRows ?? []).map((row) => [row.id, row.title]))
  }

  const assessmentById = new Map((assessmentRows ?? []).map((row) => [row.id, row]))
  const actionsByInterrupt = new Map<string, TodayInterruptAction[]>()
  for (const row of actionRows ?? []) {
    const action: TodayInterruptAction = {
      id: row.id,
      action: row.action as QuestInterruptActionType,
      reason: row.reason,
      ...(row.target_quest_id ? { targetQuestId: row.target_quest_id, targetQuestTitle: questTitles.get(row.target_quest_id) } : {}),
      ...(row.result_quest_id ? { resultQuestId: row.result_quest_id, resultQuestTitle: questTitles.get(row.result_quest_id) } : {}),
      ...(row.new_priority ? { newPriority: Number(row.new_priority) } : {}),
    }
    const list = actionsByInterrupt.get(row.interrupt_id) ?? []
    list.push(action)
    actionsByInterrupt.set(row.interrupt_id, list)
  }

  return interruptRows.flatMap((row) => {
    const assessment = assessmentById.get(row.assessment_id)
    if (!assessment) return []
    return [{
      id: row.id,
      status: row.status as QuestInterruptStatus,
      summary: row.summary,
      createdAt: row.created_at,
      ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
      assessment: {
        reason: assessment.reason,
        level: assessment.level as MaterialityLevel,
        confidence: Number(assessment.confidence),
        urgency: assessment.urgency as MaterialityUrgency,
        recommendedAction: assessment.recommended_action as MaterialityRecommendedAction,
      },
      actions: actionsByInterrupt.get(row.id) ?? [],
    }]
  })
}

export async function applySuggestedInterrupt(client: SupabaseClient, interruptId: string): Promise<void> {
  const { error } = await client.rpc('apply_suggested_quest_interrupt', { p_interrupt_id: interruptId })
  fail(error, 'apply suggested interrupt')
}
