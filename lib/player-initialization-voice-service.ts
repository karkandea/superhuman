import type { SupabaseClient } from '@supabase/supabase-js'

export const PLAYER_INITIALIZATION_AUDIO_BUCKET = 'player-initialization-audio'
export const MAX_INITIALIZATION_AUDIO_BYTES = 15 * 1024 * 1024
export const MAX_INITIALIZATION_AUDIO_DURATION_MS = 5 * 60 * 1000

const SUPPORTED_AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/x-m4a',
  'audio/ogg',
  'audio/wav',
])

function extensionForMimeType(mimeType: string) {
  switch (mimeType) {
    case 'audio/mp4':
    case 'audio/x-m4a': return 'm4a'
    case 'audio/mpeg': return 'mp3'
    case 'audio/ogg': return 'ogg'
    case 'audio/wav': return 'wav'
    default: return 'webm'
  }
}

export function chooseRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ]
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? ''
}

export function normalizeRecordedMimeType(value: string) {
  const normalized = value.split(';')[0]?.trim().toLowerCase() || 'audio/webm'
  return SUPPORTED_AUDIO_TYPES.has(normalized) ? normalized : 'audio/webm'
}

export async function submitPlayerInitializationVoiceAnswer(
  client: SupabaseClient,
  input: {
    playerId: string
    questionId: string
    audio: Blob
    durationMs: number
  },
): Promise<void> {
  if (!input.playerId) throw new Error('playerId is required')
  if (!input.questionId) throw new Error('questionId is required')
  if (input.audio.size < 1) throw new Error('Voice answer is empty.')
  if (input.audio.size > MAX_INITIALIZATION_AUDIO_BYTES) throw new Error('Voice answer is too large. Maximum size is 15 MB.')
  if (input.durationMs < 1 || input.durationMs > MAX_INITIALIZATION_AUDIO_DURATION_MS) {
    throw new Error('Voice answer must be 5 minutes or less.')
  }

  const mimeType = normalizeRecordedMimeType(input.audio.type)
  const fileName = `voice-${crypto.randomUUID()}.${extensionForMimeType(mimeType)}`
  const storagePath = `${input.playerId}/${input.questionId}/${fileName}`

  const { error: uploadError } = await client.storage
    .from(PLAYER_INITIALIZATION_AUDIO_BUCKET)
    .upload(storagePath, input.audio, {
      contentType: mimeType,
      cacheControl: '3600',
      upsert: false,
    })
  if (uploadError) throw new Error(`save voice answer: ${uploadError.message}`)

  const { error: rpcError } = await client.rpc('submit_player_initialization_voice_answer', {
    p_question_id: input.questionId,
    p_storage_path: storagePath,
    p_file_name: fileName,
    p_mime_type: mimeType,
    p_size_bytes: input.audio.size,
    p_duration_ms: Math.round(input.durationMs),
  })

  if (rpcError) {
    await client.storage.from(PLAYER_INITIALIZATION_AUDIO_BUCKET).remove([storagePath]).catch(() => {})
    throw new Error(`save voice answer: ${rpcError.message}`)
  }
}

export interface InitializationHistoryAnswer {
  id: string
  questionKey: string
  prompt: string
  origin: 'basic' | 'adaptive'
  answerMode: 'text' | 'audio'
  answerText: string | null
  durationMs: number | null
  answeredAt: string | null
  transcriptEditedByPlayer: boolean
}

export async function loadInitializationHistoryAnswers(
  client: SupabaseClient,
  playerId: string,
): Promise<InitializationHistoryAnswer[]> {
  const { data, error } = await client
    .from('player_initialization_questions')
    .select('id,question_key,prompt,origin,answer_mode,answer_text,answer_audio_duration_ms,answered_at,transcript_edited_by_player')
    .eq('user_id', playerId)
    .eq('status', 'answered')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`load initialization history: ${error.message}`)

  return (data ?? []).map(row => ({
    id: String(row.id),
    questionKey: String(row.question_key),
    prompt: String(row.prompt),
    origin: row.origin as 'basic' | 'adaptive',
    answerMode: row.answer_mode === 'audio' ? 'audio' : 'text',
    answerText: row.answer_text ? String(row.answer_text) : null,
    durationMs: row.answer_audio_duration_ms == null ? null : Number(row.answer_audio_duration_ms),
    answeredAt: row.answered_at ? String(row.answered_at) : null,
    transcriptEditedByPlayer: Boolean(row.transcript_edited_by_player),
  }))
}

export async function updateInitializationVoiceTranscript(
  client: SupabaseClient,
  questionId: string,
  transcript: string,
): Promise<void> {
  const normalized = transcript.trim()
  if (!questionId) throw new Error('questionId is required')
  if (!normalized || normalized.length > 12000) throw new Error('Transcript must be between 1 and 12000 characters.')
  const { error } = await client.rpc('update_player_initialization_voice_transcript', {
    p_question_id: questionId,
    p_transcript: normalized,
  })
  if (error) throw new Error(`update initialization transcript: ${error.message}`)
}
