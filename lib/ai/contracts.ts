import type { RetrievedPlayerContext } from '../player-understanding'

export type AiOperation = 'derive_understanding' | 'generate_daily_quests'

export interface StructuredModelRequest {
  operation: AiOperation
  schemaVersion: string
  instructions: string
  context: RetrievedPlayerContext
  responseContract: Record<string, unknown>
}

export interface AiProviderResponse {
  output: unknown
  providerId: string
  modelId: string
  requestId?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export interface AiProvider {
  readonly id: string
  invokeStructured(request: StructuredModelRequest): Promise<AiProviderResponse>
}

export interface ModelAudit {
  providerId: string
  modelId: string
  requestId?: string
  schemaVersion: string
}
