import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider, AiProviderResponse, StructuredModelRequest } from './contracts'
import { buildConsumerChatPrompt, parseConsumerChatEnvelope } from './chatgpt-consumer-provider'

interface ManualRelayProviderOptions {
  jobId: string
  userId: string
  targetDate: string
}

interface ManualInferenceTurnRow {
  id: string
  request_id: string
  request_hash: string
  status: 'pending' | 'submitted' | 'consumed' | 'invalid' | 'cancelled'
  raw_response: string | null
  parsed_response: unknown
  model_id: string | null
  validation_error: string | null
}

export class ManualInferencePendingError extends Error {
  readonly code = 'manual_inference_pending'

  constructor(
    readonly turnId: string,
    readonly operation: string,
    readonly validationError?: string | null,
  ) {
    super(validationError
      ? `Manual inference turn ${turnId} needs a corrected operator response: ${validationError}`
      : `Manual inference turn ${turnId} is waiting for operator response`)
    this.name = 'ManualInferencePendingError'
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  )
}

function requestHash(request: StructuredModelRequest) {
  const durableRequest = {
    operation: request.operation,
    schemaVersion: request.schemaVersion,
    instructions: request.instructions,
    context: request.context,
    responseContract: request.responseContract,
    // Signed attachment URLs are intentionally excluded: they are transport details that can
    // refresh between resumes. Stable attachment identity keeps the same operator turn replayable.
    attachments: (request.attachments ?? []).map(attachment => ({
      id: attachment.id,
      kind: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      label: attachment.label ?? null,
    })),
  }
  return createHash('sha256').update(JSON.stringify(stableValue(durableRequest))).digest('hex')
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 1000)
}

export class ManualRelayProvider implements AiProvider {
  readonly id = 'manual-relay'

  constructor(
    private readonly client: SupabaseClient,
    private readonly options: ManualRelayProviderOptions,
  ) {}

  private async findTurn(hash: string): Promise<ManualInferenceTurnRow | null> {
    const { data, error } = await this.client
      .from('manual_inference_turns')
      .select('id,request_id,request_hash,status,raw_response,parsed_response,model_id,validation_error')
      .eq('job_id', this.options.jobId)
      .eq('request_hash', hash)
      .maybeSingle()

    if (error) throw new Error(`load manual inference turn: ${error.message}`)
    return data as ManualInferenceTurnRow | null
  }

  private async createTurn(request: StructuredModelRequest, hash: string): Promise<ManualInferenceTurnRow> {
    const requestId = `${this.options.jobId}:${hash.slice(0, 20)}`
    const prompt = buildConsumerChatPrompt(request, requestId)
    const attachments = (request.attachments ?? []).map(attachment => ({
      id: attachment.id,
      kind: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sourceUrl: attachment.sourceUrl,
      label: attachment.label ?? null,
    }))
    const { data, error } = await this.client
      .from('manual_inference_turns')
      .insert({
        job_id: this.options.jobId,
        user_id: this.options.userId,
        target_date: this.options.targetDate,
        operation: request.operation,
        schema_version: request.schemaVersion,
        request_hash: hash,
        request_id: requestId,
        prompt,
        attachments,
        requires_web_search: request.operation === 'research_progression_context',
        status: 'pending',
      })
      .select('id,request_id,request_hash,status,raw_response,parsed_response,model_id,validation_error')
      .single()

    if (error) {
      // Another resume/worker may have created the exact deterministic turn first.
      const existing = await this.findTurn(hash)
      if (existing) return existing
      throw new Error(`create manual inference turn: ${error.message}`)
    }
    return data as ManualInferenceTurnRow
  }

  private async consumeSubmittedTurn(
    request: StructuredModelRequest,
    turn: ManualInferenceTurnRow,
  ): Promise<AiProviderResponse> {
    if (!turn.raw_response?.trim()) {
      throw new ManualInferencePendingError(turn.id, request.operation, 'Submitted response is empty')
    }

    let payload: unknown
    try {
      payload = parseConsumerChatEnvelope(turn.raw_response, {
        requestId: turn.request_id,
        operation: request.operation,
        schemaVersion: request.schemaVersion,
      }).payload
    } catch (error) {
      const validationError = boundedError(error)
      const { error: updateError } = await this.client
        .from('manual_inference_turns')
        .update({
          status: 'invalid',
          parsed_response: null,
          validation_error: validationError,
          updated_at: new Date().toISOString(),
        })
        .eq('id', turn.id)
      if (updateError) throw new Error(`mark manual inference turn invalid: ${updateError.message}`)
      throw new ManualInferencePendingError(turn.id, request.operation, validationError)
    }

    const { error } = await this.client
      .from('manual_inference_turns')
      .update({
        status: 'consumed',
        parsed_response: payload,
        validation_error: null,
        consumed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', turn.id)
    if (error) throw new Error(`consume manual inference turn: ${error.message}`)

    return {
      output: payload,
      providerId: this.id,
      modelId: turn.model_id?.trim() || 'chatgpt-manual',
      requestId: turn.request_id,
      conversationRef: `manual-relay:${turn.id}`,
    }
  }

  async invokeStructured(request: StructuredModelRequest): Promise<AiProviderResponse> {
    const hash = requestHash(request)
    const turn = await this.findTurn(hash) ?? await this.createTurn(request, hash)

    if (turn.status === 'submitted') {
      return this.consumeSubmittedTurn(request, turn)
    }

    if (turn.status === 'consumed' && turn.parsed_response !== null) {
      return {
        output: turn.parsed_response,
        providerId: this.id,
        modelId: turn.model_id?.trim() || 'chatgpt-manual',
        requestId: turn.request_id,
        conversationRef: `manual-relay:${turn.id}`,
      }
    }

    if (turn.status === 'cancelled') {
      throw new Error(`Manual inference turn ${turn.id} was cancelled`)
    }

    throw new ManualInferencePendingError(turn.id, request.operation, turn.validation_error)
  }

  consumeConversationRefs(): string[] {
    return []
  }
}
