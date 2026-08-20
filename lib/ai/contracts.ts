import type { MaterialityContext } from '../materiality'
import type { ProgressionIntelligenceContext } from '../progression-intelligence'
import type { RetrievedPlayerContext } from '../player-understanding'

export type AiOperation =
  | 'derive_understanding'
  | 'derive_understanding_delta'
  | 'calibrate_player_initialization'
  | 'derive_progression_map'
  | 'review_quest_responses'
  | 'derive_player_response_model'
  | 'choose_progression_target'
  | 'generate_daily_quests'
  | 'assess_materiality'
  | 'generate_system_interrupt'

export type AiRequestContext =
  | RetrievedPlayerContext
  | MaterialityContext
  | ProgressionIntelligenceContext
  | (RetrievedPlayerContext & { initialization: unknown })

export interface StructuredModelRequest {
  operation: AiOperation
  schemaVersion: string
  instructions: string
  context: AiRequestContext
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
