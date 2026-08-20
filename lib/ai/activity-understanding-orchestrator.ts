import type { StructuredModelAttachment, ModelAudit } from './contracts'
import type {
  DeriveUnderstandingDeltaDependencies,
  UnderstandingRepository,
} from './orchestrator-core'
import { derivePlayerUnderstandingDelta as deriveInitializationAwareDelta } from './player-initialization-orchestrator'
import {
  UNDERSTANDING_TYPES,
  validateUnderstandingDelta,
  type PersistedUnderstandingDeltaResult,
  type UnderstandingDeltaAction,
} from '../player-understanding'

export const VOICE_UNDERSTANDING_DELTA_SCHEMA_VERSION = 'understanding-delta.v2'

export interface ActivityVoiceAttachment {
  sourceKnowledgeEntryId: string
  attachment: StructuredModelAttachment
}

export interface ActivityVoiceTranscript {
  sourceKnowledgeEntryId: string
  transcript: string
}

interface VoiceTranscriptRepository extends UnderstandingRepository {
  persistVoiceTranscripts?(input: {
    playerId: string
    transcripts: ActivityVoiceTranscript[]
    audit: ModelAudit
  }): Promise<void>
}

function validateVoiceTranscripts(value: unknown, attachments: ActivityVoiceAttachment[]): ActivityVoiceTranscript[] {
  if (!Array.isArray(value)) throw new Error('Activity voiceTranscripts must be an array')
  if (value.length !== attachments.length) {
    throw new Error('Activity voiceTranscripts must cover every attached voice update exactly once')
  }

  const allowed = new Set(attachments.map(item => item.sourceKnowledgeEntryId))
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Activity voice transcript ${index} must be an object`)
    }
    const row = item as Record<string, unknown>
    const sourceKnowledgeEntryId = String(row.sourceKnowledgeEntryId ?? '').trim()
    const transcript = String(row.transcript ?? '').trim()
    if (!allowed.has(sourceKnowledgeEntryId)) throw new Error('Activity voice transcript references unattached knowledge')
    if (seen.has(sourceKnowledgeEntryId)) throw new Error('Activity voice transcript source is duplicated')
    if (transcript.length < 1 || transcript.length > 12000) {
      throw new Error('Activity voice transcript must be between 1 and 12000 characters')
    }
    seen.add(sourceKnowledgeEntryId)
    return { sourceKnowledgeEntryId, transcript }
  })
}

export async function derivePlayerUnderstandingDelta(
  dependencies: DeriveUnderstandingDeltaDependencies & { repository: VoiceTranscriptRepository },
  input: {
    playerId: string
    knowledgeEntryIds: string[]
    date: string
    batchKey: string
    limit?: number
    voiceAttachments?: ActivityVoiceAttachment[]
  },
): Promise<{ actions: UnderstandingDeltaAction[]; persistence: PersistedUnderstandingDeltaResult }> {
  const voiceAttachments = input.voiceAttachments ?? []
  if (voiceAttachments.length === 0) {
    return deriveInitializationAwareDelta(dependencies, input)
  }

  const provider = dependencies.provider
  if (!provider || typeof provider.invokeStructured !== 'function') throw new Error('AI provider is required')
  if (!input.playerId) throw new Error('playerId is required')
  if (input.knowledgeEntryIds.length === 0) throw new Error('At least one knowledge entry is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('date must use YYYY-MM-DD')
  if (!input.batchKey.trim()) throw new Error('batchKey is required')

  const knowledgeIds = [...new Set(input.knowledgeEntryIds)]
  const allowedKnowledgeIds = new Set(knowledgeIds)
  for (const item of voiceAttachments) {
    if (!allowedKnowledgeIds.has(item.sourceKnowledgeEntryId)) {
      throw new Error('Activity voice attachment references knowledge outside the activity batch')
    }
  }

  const context = await dependencies.contextRetriever.retrieveForUnderstandingDelta({
    playerId: input.playerId,
    knowledgeEntryIds: knowledgeIds,
    date: input.date,
    limit: input.limit ?? 24,
  })
  if (context.playerId !== input.playerId) throw new Error('Retrieved context belongs to another player')
  if (context.knowledgeEntries.length === 0) throw new Error('No player knowledge was retrieved')
  if (!context.playerBrief) throw new Error('Canonical Player Brief is required for understanding delta')

  const response = await provider.invokeStructured({
    operation: 'derive_understanding_delta',
    schemaVersion: VOICE_UNDERSTANDING_DELTA_SCHEMA_VERSION,
    instructions: [
      'Treat playerBrief as the canonical current state of this player. Do not reconstruct identity from scratch and do not treat conversation history as memory.',
      'Compare only the new knowledgeEntries against playerBrief, active signals, recent quest results, and active quests, then return the smallest evidence-backed state delta.',
      'Some new knowledge entries are raw voice evidence. For each attached audio file, understand the raw speech directly in this same reasoning call. Do not require or assume a separate transcription service or model call.',
      'Return exactly one faithful voiceTranscripts item for every attached voice update. Preserve the player language and meaning; transcript is evidence representation, not a creative summary. If speech is partly unclear, transcribe only what is supportable and never invent missing speech.',
      'Valid understanding actions are create, update, resolve, supersede. Return actions: [] when the new activity does not materially change persistent player understanding.',
      'Use create only for genuinely new persistent understanding. Use update when an existing understanding is the same concept but evolved. Use resolve when it is no longer true/relevant. Use supersede when new evidence replaces or contradicts it.',
      `For create/update/supersede, type must be exactly one of: ${UNDERSTANDING_TYPES.join(', ')}.`,
      'targetUnderstandingId may only reference playerBrief.activeUnderstandingIds. create must not target an existing understanding.',
      'Every action must cite sourceKnowledgeEntryIds from context.knowledgeEntries only. Raw voice provenance is the marker knowledge entry paired with that attachment.',
      'Temporary evidence must not become permanent identity. Never infer goals or identity from occupation, demographics, or stereotypes.',
    ].join(' '),
    context,
    attachments: voiceAttachments.map(item => item.attachment),
    responseContract: {
      type: 'object',
      required: ['actions', 'voiceTranscripts'],
      actions: [{
        action: ['create', 'update', 'resolve', 'supersede'],
        targetUnderstandingId: 'required for update/resolve/supersede; id from playerBrief.activeUnderstandingIds only; forbidden for create',
        type: [...UNDERSTANDING_TYPES, 'required for create/update/supersede; omit for resolve'],
        summary: 'non-empty string required for create/update/supersede; omit for resolve',
        details: 'object required for create/update/supersede; omit for resolve',
        confidence: 'number 0..1 required for create/update/supersede; omit for resolve',
        importance: 'integer 1..5 required for create/update/supersede; omit for resolve',
        sourceKnowledgeEntryIds: 'non-empty array of ids from context.knowledgeEntries only',
        evidenceExcerpt: 'optional string copied or tightly paraphrased from source evidence',
        reason: 'non-empty concise reason for this state transition',
      }],
      voiceTranscripts: [{
        sourceKnowledgeEntryId: 'exact knowledge entry id paired with one attached voice update',
        transcript: 'faithful non-empty transcript of that attached player speech; preserve language and meaning; do not summarize or invent',
      }],
    },
  })

  const raw = response.output as Record<string, unknown>
  const allowedRetrievedKnowledgeIds = new Set(context.knowledgeEntries.map(entry => entry.id))
  const actions = validateUnderstandingDelta(
    { actions: raw.actions },
    allowedRetrievedKnowledgeIds,
    new Set(context.playerBrief.activeUnderstandingIds),
  )
  const transcripts = validateVoiceTranscripts(raw.voiceTranscripts, voiceAttachments)
  if (!dependencies.repository.persistVoiceTranscripts) {
    throw new Error('Voice transcript persistence is required for activity voice evidence')
  }

  const audit: ModelAudit = {
    providerId: response.providerId,
    modelId: response.modelId,
    requestId: response.requestId,
    schemaVersion: VOICE_UNDERSTANDING_DELTA_SCHEMA_VERSION,
  }

  // Persist the faithful transcript before the understanding delta. If a later persistence step
  // fails, a retry can reason from the saved transcript instead of re-uploading/re-transcribing audio.
  await dependencies.repository.persistVoiceTranscripts({
    playerId: input.playerId,
    transcripts,
    audit,
  })

  const persistence = await dependencies.repository.persistDelta({
    playerId: input.playerId,
    actions,
    batchKey: input.batchKey,
    audit,
    context,
  })

  return { actions, persistence }
}
