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
  | 'repair_daily_quest_output'
  | 'assess_materiality'
  | 'generate_system_interrupt'

export interface QuestOutputRepairContext extends ProgressionIntelligenceContext {
  questRepair: {
    validatorCode: string
    validatorMessage: string
    previousOutput: unknown
  }
}

export type AiRequestContext =
  | RetrievedPlayerContext
  | MaterialityContext
  | ProgressionIntelligenceContext
  | QuestOutputRepairContext
  | (RetrievedPlayerContext & { initialization: unknown })

export interface StructuredModelAttachment {
  id: string
  kind: 'audio'
  fileName: string
  mimeType: string
  sourceUrl: string
  label?: string
}

export interface StructuredModelRequest {
  operation: AiOperation
  schemaVersion: string
  instructions: string
  context: AiRequestContext
  responseContract: Record<string, unknown>
  attachments?: StructuredModelAttachment[]
}

export interface AiProviderResponse {
  output: unknown
  providerId: string
  modelId: string
  requestId?: string
  conversationRef?: string
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
  conversationRef?: string
  schemaVersion: string
}
