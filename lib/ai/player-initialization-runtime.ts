import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { InitializationCalibrationDecision } from '../player-initialization'

export interface InitializationRuntimeQuestion {
  id: string
  origin: 'basic' | 'adaptive'
  questionKey: string
  dimension: string
  prompt: string
  status: 'pending' | 'answered' | 'skipped' | 'superseded'
  answer: string | null
  answerKnowledgeEntryId: string | null
  calibrationVersion: number
}

export interface InitializationRuntimeContext {
  stage: 'initializing' | 'calibrating'
  readiness: 'ask'
  calibrationVersion: number
  previousDimensions: Record<string, unknown>
  previousReason: string | null
  questions: InitializationRuntimeQuestion[]
}

let runtimeClient: SupabaseClient | null | undefined

function client(): SupabaseClient | null {
  if (runtimeClient !== undefined) return runtimeClient
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    runtimeClient = null
    return runtimeClient
  }
  runtimeClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return runtimeClient
}

export async function isPlayerInitializationReady(playerId: string): Promise<boolean> {
  const supabase = client()
  if (!supabase) return true
  const { data, error } = await supabase
    .from('player_initializations')
    .select('readiness')
    .eq('user_id', playerId)
    .maybeSingle()
  if (error) throw new Error(`load Player Initialization readiness: ${error.message}`)
  return data?.readiness === 'ready'
}

export async function loadInitializationRuntimeContext(
  playerId: string,
  currentKnowledgeEntryIds: string[],
): Promise<InitializationRuntimeContext | null> {
  const supabase = client()
  if (!supabase) return null

  const [{ data: state, error: stateError }, { data: rows, error: questionError }] = await Promise.all([
    supabase
      .from('player_initializations')
      .select('stage,readiness,readiness_dimensions,readiness_reason,calibration_version')
      .eq('user_id', playerId)
      .maybeSingle(),
    supabase
      .from('player_initialization_questions')
      .select('id,origin,question_key,dimension,prompt,status,answer_text,answer_knowledge_entry_id,calibration_version')
      .eq('user_id', playerId)
      .order('created_at', { ascending: true }),
  ])
  if (stateError) throw new Error(`load Player Initialization runtime state: ${stateError.message}`)
  if (questionError) throw new Error(`load Player Initialization runtime questions: ${questionError.message}`)
  if (!state || state.readiness === 'ready') return null

  const questions = (rows ?? []).map(row => ({
    id: String(row.id),
    origin: row.origin as 'basic' | 'adaptive',
    questionKey: String(row.question_key),
    dimension: String(row.dimension),
    prompt: String(row.prompt),
    status: row.status as InitializationRuntimeQuestion['status'],
    answer: row.answer_text ? String(row.answer_text) : null,
    answerKnowledgeEntryId: row.answer_knowledge_entry_id ? String(row.answer_knowledge_entry_id) : null,
    calibrationVersion: Number(row.calibration_version ?? 0),
  }))

  if (questions.some(question => question.status === 'pending')) return null

  const answeredIds = new Set(
    questions
      .filter(question => question.status === 'answered' && question.answerKnowledgeEntryId)
      .map(question => String(question.answerKnowledgeEntryId)),
  )
  if (answeredIds.size === 0) return null
  if (!currentKnowledgeEntryIds.some(id => answeredIds.has(id))) return null

  return {
    stage: state.stage === 'calibrating' ? 'calibrating' : 'initializing',
    readiness: 'ask',
    calibrationVersion: Number(state.calibration_version ?? 0),
    previousDimensions: state.readiness_dimensions && typeof state.readiness_dimensions === 'object'
      ? state.readiness_dimensions as Record<string, unknown>
      : {},
    previousReason: state.readiness_reason ? String(state.readiness_reason) : null,
    questions,
  }
}

export async function persistInitializationRuntimeDecision(
  playerId: string,
  decision: InitializationCalibrationDecision,
  audit: {
    providerId: string
    modelId: string
    requestId?: string
    schemaVersion: string
  },
): Promise<void> {
  const supabase = client()
  if (!supabase) throw new Error('Player Initialization runtime persistence requires Supabase worker credentials')

  const { error } = await supabase.rpc('persist_player_initialization_calibration_internal', {
    p_user_id: playerId,
    p_readiness: decision.readiness,
    p_reason: decision.reason,
    p_dimensions: decision.dimensions,
    p_questions: decision.questions,
    p_provider_id: audit.providerId,
    p_model_id: audit.modelId,
    p_request_id: audit.requestId ?? null,
    p_schema_version: audit.schemaVersion,
  })
  if (error) throw new Error(`persist Player Initialization calibration: ${error.message}`)
}
