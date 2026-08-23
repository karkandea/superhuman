import type { SupabaseClient } from '@supabase/supabase-js'

export type PlayerTurnOwner = 'player' | 'system' | 'none'
export type PlayerWorkflowPhase =
  | 'needs_checkin'
  | 'understanding'
  | 'choosing_focus'
  | 'preparing_quests'
  | 'quest_ready'
  | 'no_action'
  | 'needs_more_context'
  | 'stopped'
export type PlayerWorkflowActivity = 'idle' | 'queued' | 'running' | 'stalled' | 'ready' | 'failed'

export interface PlayerWorkflowStatus {
  targetDate: string
  turnOwner: PlayerTurnOwner
  phase: PlayerWorkflowPhase
  activity: PlayerWorkflowActivity
  actionableQuestCount: number
  questCount: number
  noQuest: boolean
  canStart: boolean
  activeSince?: string
  etaOperation?: 'progression_target' | 'quest_generation' | 'quest_repair'
  etaSampleCount?: number
  etaP50Ms?: number
  etaP80Ms?: number
  longerThanUsual?: boolean
  updatedAt: string
}

const TURN_OWNERS = new Set<PlayerTurnOwner>(['player', 'system', 'none'])
const PHASES = new Set<PlayerWorkflowPhase>([
  'needs_checkin', 'understanding', 'choosing_focus', 'preparing_quests',
  'quest_ready', 'no_action', 'needs_more_context', 'stopped',
])
const ACTIVITIES = new Set<PlayerWorkflowActivity>(['idle', 'queued', 'running', 'stalled', 'ready', 'failed'])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown) {
  const resolved = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(resolved) ? resolved : undefined
}

function mapWorkflowStatus(value: unknown): PlayerWorkflowStatus {
  const row = record(value)
  const targetDate = stringValue(row.targetDate)
  const turnOwner = stringValue(row.turnOwner) as PlayerTurnOwner | undefined
  const phase = stringValue(row.phase) as PlayerWorkflowPhase | undefined
  const activity = stringValue(row.activity) as PlayerWorkflowActivity | undefined
  const updatedAt = stringValue(row.updatedAt)

  if (!targetDate || !turnOwner || !TURN_OWNERS.has(turnOwner) || !phase || !PHASES.has(phase) || !activity || !ACTIVITIES.has(activity) || !updatedAt) {
    throw new Error('Player workflow status is invalid')
  }

  const etaOperation = stringValue(row.etaOperation)
  const etaP50Ms = numberValue(row.etaP50Ms)
  const etaP80Ms = numberValue(row.etaP80Ms)
  const etaSampleCount = numberValue(row.etaSampleCount)
  const activeSince = stringValue(row.activeSince)

  return {
    targetDate,
    turnOwner,
    phase,
    activity,
    actionableQuestCount: numberValue(row.actionableQuestCount) ?? 0,
    questCount: numberValue(row.questCount) ?? 0,
    noQuest: row.noQuest === true,
    canStart: row.canStart === true,
    ...(activeSince ? { activeSince } : {}),
    ...(etaOperation === 'progression_target' || etaOperation === 'quest_generation' || etaOperation === 'quest_repair' ? { etaOperation } : {}),
    ...(etaSampleCount !== undefined ? { etaSampleCount } : {}),
    ...(etaP50Ms !== undefined ? { etaP50Ms } : {}),
    ...(etaP80Ms !== undefined ? { etaP80Ms } : {}),
    ...(row.longerThanUsual === true ? { longerThanUsual: true } : {}),
    updatedAt,
  }
}

export async function getPlayerWorkflowStatus(client: SupabaseClient, targetDate: string): Promise<PlayerWorkflowStatus> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('targetDate must use YYYY-MM-DD')
  const { data, error } = await client.rpc('get_player_workflow_status', { p_target_date: targetDate })
  if (error) throw new Error(`load player workflow status: ${error.message}`)
  return mapWorkflowStatus(data)
}
