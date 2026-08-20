import type { SupabaseClient } from '@supabase/supabase-js'
import { getAiInferenceJob, type AiInferenceJob } from './ai/inference-job-service'
import type {
  InitializationDimension,
  InitializationQuestionOrigin,
  InitializationQuestionStatus,
  InitializationReadiness,
  InitializationStage,
} from './player-initialization'

export interface PlayerInitializationState {
  userId: string
  stage: InitializationStage
  readiness: InitializationReadiness
  readinessDimensions: Record<string, unknown>
  readinessReason: string | null
  calibrationVersion: number
  lastCalibratedAt: string | null
  readyAt: string | null
  updatedAt: string
}

export interface PlayerInitializationQuestion {
  id: string
  origin: InitializationQuestionOrigin
  questionKey: string
  dimension: InitializationDimension
  prompt: string
  reason: string | null
  priority: number
  sequence: number
  calibrationVersion: number
  status: InitializationQuestionStatus
  answerText: string | null
  answeredAt: string | null
}

function mapState(row: Record<string, unknown>): PlayerInitializationState {
  return {
    userId: String(row.user_id),
    stage: row.stage as InitializationStage,
    readiness: row.readiness as InitializationReadiness,
    readinessDimensions: row.readiness_dimensions && typeof row.readiness_dimensions === 'object'
      ? row.readiness_dimensions as Record<string, unknown>
      : {},
    readinessReason: row.readiness_reason ? String(row.readiness_reason) : null,
    calibrationVersion: Number(row.calibration_version ?? 0),
    lastCalibratedAt: row.last_calibrated_at ? String(row.last_calibrated_at) : null,
    readyAt: row.ready_at ? String(row.ready_at) : null,
    updatedAt: String(row.updated_at),
  }
}

function mapQuestion(row: Record<string, unknown>): PlayerInitializationQuestion {
  return {
    id: String(row.id),
    origin: row.origin as InitializationQuestionOrigin,
    questionKey: String(row.question_key),
    dimension: row.dimension as InitializationDimension,
    prompt: String(row.prompt),
    reason: row.reason ? String(row.reason) : null,
    priority: Number(row.priority ?? 3),
    sequence: Number(row.sequence ?? 0),
    calibrationVersion: Number(row.calibration_version ?? 0),
    status: row.status as InitializationQuestionStatus,
    answerText: row.answer_text ? String(row.answer_text) : null,
    answeredAt: row.answered_at ? String(row.answered_at) : null,
  }
}

const STATE_COLUMNS = 'user_id,stage,readiness,readiness_dimensions,readiness_reason,calibration_version,last_calibrated_at,ready_at,updated_at'
const QUESTION_COLUMNS = 'id,origin,question_key,dimension,prompt,reason,priority,sequence,calibration_version,status,answer_text,answered_at'

export async function ensurePlayerInitialization(client: SupabaseClient): Promise<PlayerInitializationState> {
  const { data, error } = await client.rpc('ensure_player_initialization')
  if (error) throw new Error(`ensure Player Initialization: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') throw new Error('ensure Player Initialization returned no state')
  return mapState(row as Record<string, unknown>)
}

export async function loadPlayerInitialization(
  client: SupabaseClient,
  playerId: string,
): Promise<{ state: PlayerInitializationState; questions: PlayerInitializationQuestion[] }> {
  if (!playerId) throw new Error('playerId is required')
  const [{ data: state, error: stateError }, { data: questions, error: questionError }] = await Promise.all([
    client.from('player_initializations').select(STATE_COLUMNS).eq('user_id', playerId).single(),
    client.from('player_initialization_questions').select(QUESTION_COLUMNS).eq('user_id', playerId),
  ])
  if (stateError) throw new Error(`load Player Initialization: ${stateError.message}`)
  if (questionError) throw new Error(`load Player Initialization questions: ${questionError.message}`)
  return {
    state: mapState(state as Record<string, unknown>),
    questions: (questions ?? []).map(row => mapQuestion(row as Record<string, unknown>)),
  }
}

export async function answerPlayerInitializationQuestion(
  client: SupabaseClient,
  questionId: string,
  answer: string,
): Promise<void> {
  const normalized = answer.trim()
  if (!questionId) throw new Error('questionId is required')
  if (!normalized) throw new Error('answer is required')
  const { error } = await client.rpc('submit_player_initialization_answer', {
    p_question_id: questionId,
    p_answer: normalized,
    p_skip: false,
  })
  if (error) throw new Error(`save Player Initialization answer: ${error.message}`)
}

export async function skipPlayerInitializationQuestion(
  client: SupabaseClient,
  questionId: string,
): Promise<void> {
  if (!questionId) throw new Error('questionId is required')
  const { error } = await client.rpc('submit_player_initialization_answer', {
    p_question_id: questionId,
    p_answer: null,
    p_skip: true,
  })
  if (error) throw new Error(`skip Player Initialization question: ${error.message}`)
}

export async function resetSkippedPlayerInitializationQuestions(client: SupabaseClient): Promise<number> {
  const { data, error } = await client.rpc('reset_skipped_initialization_questions')
  if (error) throw new Error(`reset skipped Player Initialization questions: ${error.message}`)
  return Number(data ?? 0)
}

export async function requestPlayerInitializationCalibration(client: SupabaseClient): Promise<AiInferenceJob> {
  const { data, error } = await client.rpc('request_initialization_calibration')
  if (error) throw new Error(`request Player Initialization calibration: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object' || !('id' in row)) {
    throw new Error('request Player Initialization calibration returned no job')
  }
  const job = await getAiInferenceJob(client, String((row as Record<string, unknown>).id))
  if (!job) throw new Error('Player Initialization calibration job disappeared')
  return job
}
