import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { InitializationCalibrationDecision } from '../player-initialization'

const INITIALIZATION_AUDIO_BUCKET = 'player-initialization-audio'

export interface InitializationRuntimeQuestion {
  id: string
  origin: 'basic' | 'adaptive'
  questionKey: string
  dimension: string
  prompt: string
  status: 'pending' | 'answered' | 'skipped' | 'superseded'
  answerMode: 'text' | 'audio'
  answer: string | null
  answerKnowledgeEntryId: string | null
  voiceAttachmentId: string | null
  calibrationVersion: number
}

export interface InitializationRuntimeAttachment {
  id: string
  questionId: string
  sourceKnowledgeEntryId: string
  kind: 'audio'
  fileName: string
  mimeType: string
  sourceUrl: string
}

export interface InitializationRuntimeContext {
  stage: 'initializing' | 'calibrating'
  readiness: 'ask'
  calibrationVersion: number
  previousDimensions: Record<string, unknown>
  previousReason: string | null
  questions: InitializationRuntimeQuestion[]
  attachments: InitializationRuntimeAttachment[]
}

export interface InitializationVoiceTranscript {
  questionId: string
  sourceKnowledgeEntryId: string
  transcript: string
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

export async function shouldDeferProgressionMapForInitialization(playerId: string): Promise<boolean> {
  const supabase = client()
  if (!supabase) return false
  const { data, error } = await supabase
    .from('player_initializations')
    .select('readiness,strategic_activation_pending')
    .eq('user_id', playerId)
    .maybeSingle()
  if (error) throw new Error(`load Player Initialization strategic gate: ${error.message}`)
  if (!data) return false
  return data.readiness !== 'ready' || Boolean(data.strategic_activation_pending)
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
      .select('id,origin,question_key,dimension,prompt,status,answer_mode,answer_text,answer_knowledge_entry_id,answer_audio_storage_path,answer_audio_file_name,answer_audio_mime_type,transcript_text,calibration_version')
      .eq('user_id', playerId)
      .order('created_at', { ascending: true }),
  ])
  if (stateError) throw new Error(`load Player Initialization runtime state: ${stateError.message}`)
  if (questionError) throw new Error(`load Player Initialization runtime questions: ${questionError.message}`)
  if (!state || state.readiness === 'ready') return null

  const attachmentRows = (rows ?? []).filter(row =>
    row.status === 'answered'
    && row.answer_mode === 'audio'
    && !row.transcript_text
    && row.answer_audio_storage_path
    && row.answer_knowledge_entry_id,
  )

  const attachments: InitializationRuntimeAttachment[] = []
  for (const row of attachmentRows) {
    const storagePath = String(row.answer_audio_storage_path)
    const { data, error } = await supabase.storage.from(INITIALIZATION_AUDIO_BUCKET).createSignedUrl(storagePath, 600)
    if (error || !data?.signedUrl) throw new Error(`load initialization audio evidence: ${error?.message ?? 'signed URL missing'}`)
    attachments.push({
      id: `initialization-audio:${String(row.id)}`,
      questionId: String(row.id),
      sourceKnowledgeEntryId: String(row.answer_knowledge_entry_id),
      kind: 'audio',
      fileName: String(row.answer_audio_file_name || `voice-${String(row.id)}.webm`),
      mimeType: String(row.answer_audio_mime_type || 'audio/webm'),
      sourceUrl: data.signedUrl,
    })
  }

  const attachmentByQuestion = new Map(attachments.map(attachment => [attachment.questionId, attachment.id]))
  const questions = (rows ?? []).map(row => ({
    id: String(row.id),
    origin: row.origin as 'basic' | 'adaptive',
    questionKey: String(row.question_key),
    dimension: String(row.dimension),
    prompt: String(row.prompt),
    status: row.status as InitializationRuntimeQuestion['status'],
    answerMode: row.answer_mode === 'audio' ? 'audio' as const : 'text' as const,
    answer: row.answer_text ? String(row.answer_text) : null,
    answerKnowledgeEntryId: row.answer_knowledge_entry_id ? String(row.answer_knowledge_entry_id) : null,
    voiceAttachmentId: attachmentByQuestion.get(String(row.id)) ?? null,
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
    attachments,
  }
}

export async function persistInitializationRuntimeDecision(
  playerId: string,
  decision: InitializationCalibrationDecision,
  voiceTranscripts: InitializationVoiceTranscript[],
  audit: {
    providerId: string
    modelId: string
    requestId?: string
    schemaVersion: string
  },
): Promise<void> {
  const supabase = client()
  if (!supabase) throw new Error('Player Initialization runtime persistence requires Supabase worker credentials')

  const { error } = await supabase.rpc('persist_player_initialization_calibration_v2_internal', {
    p_user_id: playerId,
    p_readiness: decision.readiness,
    p_reason: decision.reason,
    p_dimensions: decision.dimensions,
    p_questions: decision.questions,
    p_voice_transcripts: voiceTranscripts,
    p_provider_id: audit.providerId,
    p_model_id: audit.modelId,
    p_request_id: audit.requestId ?? null,
    p_schema_version: audit.schemaVersion,
  })
  if (error) throw new Error(`persist Player Initialization calibration: ${error.message}`)
}
