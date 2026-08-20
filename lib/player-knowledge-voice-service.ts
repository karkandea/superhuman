import type { SupabaseClient } from '@supabase/supabase-js'

export const PLAYER_KNOWLEDGE_AUDIO_BUCKET = 'player-knowledge-audio'
export const MAX_KNOWLEDGE_AUDIO_BYTES = 15 * 1024 * 1024
export const MAX_KNOWLEDGE_AUDIO_DURATION_MS = 5 * 60 * 1000

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

export function chooseKnowledgeRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ]
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? ''
}

export function normalizeKnowledgeRecordedMimeType(value: string) {
  const normalized = value.split(';')[0]?.trim().toLowerCase() || 'audio/webm'
  return SUPPORTED_AUDIO_TYPES.has(normalized) ? normalized : 'audio/webm'
}

export async function ingestVoiceKnowledge(
  client: SupabaseClient,
  input: {
    playerId: string
    audio: Blob
    durationMs: number
    occurredAt?: string
  },
): Promise<string> {
  if (!input.playerId) throw new Error('playerId is required')
  if (input.audio.size < 1) throw new Error('Voice update is empty.')
  if (input.audio.size > MAX_KNOWLEDGE_AUDIO_BYTES) throw new Error('Voice update is too large. Maximum size is 15 MB.')
  if (input.durationMs < 1 || input.durationMs > MAX_KNOWLEDGE_AUDIO_DURATION_MS) {
    throw new Error('Voice update must be 5 minutes or less.')
  }

  const mimeType = normalizeKnowledgeRecordedMimeType(input.audio.type)
  const fileName = `voice-${crypto.randomUUID()}.${extensionForMimeType(mimeType)}`
  const storagePath = `${input.playerId}/updates/${fileName}`

  const { error: uploadError } = await client.storage
    .from(PLAYER_KNOWLEDGE_AUDIO_BUCKET)
    .upload(storagePath, input.audio, {
      contentType: mimeType,
      cacheControl: '3600',
      upsert: false,
    })
  if (uploadError) throw new Error(`save voice update: ${uploadError.message}`)

  const { data, error: rpcError } = await client.rpc('ingest_manual_voice_knowledge', {
    p_storage_path: storagePath,
    p_file_name: fileName,
    p_mime_type: mimeType,
    p_size_bytes: input.audio.size,
    p_duration_ms: Math.round(input.durationMs),
    p_occurred_at: input.occurredAt ?? new Date().toISOString(),
  })

  if (rpcError) {
    await client.storage.from(PLAYER_KNOWLEDGE_AUDIO_BUCKET).remove([storagePath]).catch(() => {})
    throw new Error(`save voice update: ${rpcError.message}`)
  }
  if (typeof data !== 'string' || !data) throw new Error('Voice knowledge ingestion did not return an entry ID')
  return data
}
