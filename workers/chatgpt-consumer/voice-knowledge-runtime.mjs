import { derivePlayerUnderstandingDelta } from '../../lib/ai/orchestrator.ts'

const VOICE_BUCKET = 'player-knowledge-audio'
const SIGNED_URL_TTL_SECONDS = 300

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

async function loadPendingVoiceAttachments(client, playerId, knowledgeEntryIds) {
  if (knowledgeEntryIds.length === 0) return []
  const { data, error } = await client
    .from('knowledge_entries')
    .select('id,content_metadata')
    .eq('user_id', playerId)
    .in('id', knowledgeEntryIds)
  if (error) throw new Error(`load voice knowledge metadata: ${error.message}`)

  const attachments = []
  for (const row of data || []) {
    const metadata = record(row.content_metadata)
    if (metadata.input !== 'voice' || metadata.storageBucket !== VOICE_BUCKET || metadata.transcriptStatus === 'ready') continue

    const storagePath = typeof metadata.storagePath === 'string' ? metadata.storagePath.trim() : ''
    const fileName = typeof metadata.fileName === 'string' ? metadata.fileName.trim() : ''
    const mimeType = typeof metadata.mimeType === 'string' ? metadata.mimeType.trim() : ''
    if (!storagePath.startsWith(`${playerId}/updates/`) || !fileName || !mimeType.startsWith('audio/')) {
      throw new Error('Voice knowledge metadata is invalid')
    }

    const { data: signed, error: signedError } = await client.storage
      .from(VOICE_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
    if (signedError || !signed?.signedUrl) {
      throw new Error(`sign voice knowledge audio: ${signedError?.message || 'signed URL missing'}`)
    }

    attachments.push({
      sourceKnowledgeEntryId: String(row.id),
      attachment: {
        id: `knowledge-audio:${row.id}`,
        kind: 'audio',
        fileName,
        mimeType,
        sourceUrl: signed.signedUrl,
        label: `Raw player voice update; source knowledge ${row.id}`,
      },
    })
  }

  const order = new Map(knowledgeEntryIds.map((id, index) => [String(id), index]))
  return attachments.sort((left, right) => (order.get(left.sourceKnowledgeEntryId) ?? 0) - (order.get(right.sourceKnowledgeEntryId) ?? 0))
}

function withVoiceTranscriptPersistence(client, repository) {
  return {
    ...repository,
    async persistVoiceTranscripts({ playerId, transcripts, audit }) {
      const { error } = await client.rpc('persist_knowledge_voice_transcripts_internal', {
        p_user_id: playerId,
        p_items: transcripts,
        p_provider_id: audit.providerId,
        p_model_id: audit.modelId,
        p_request_id: audit.requestId ?? null,
        p_schema_version: audit.schemaVersion,
      })
      if (error) throw new Error(`persist voice knowledge transcripts: ${error.message}`)
    },
  }
}

export async function deriveActivityUnderstandingDelta(
  { client, provider, contextRetriever, repository },
  input,
) {
  const voiceAttachments = await loadPendingVoiceAttachments(client, input.playerId, input.knowledgeEntryIds)
  return derivePlayerUnderstandingDelta({
    provider,
    contextRetriever,
    repository: withVoiceTranscriptPersistence(client, repository),
  }, {
    ...input,
    ...(voiceAttachments.length > 0 ? { voiceAttachments } : {}),
  })
}
