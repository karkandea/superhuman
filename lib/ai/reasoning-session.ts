import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { StructuredModelRequest } from './contracts'

const INITIALIZATION_PHASE_KEY = 'player_initialization'
const CONSUMER_PROVIDER_ID = 'chatgpt-consumer-web'

export interface ConsumerConversationHint {
  temporaryChat: true
  conversationRef?: string
}

let sessionClient: SupabaseClient | null | undefined

function client(): SupabaseClient | null {
  if (process.env.SUPERHUMAN_TEST_MODE === '1') return null
  if (sessionClient !== undefined) return sessionClient
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    sessionClient = null
    return sessionClient
  }
  sessionClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return sessionClient
}

function playerIdFrom(request: StructuredModelRequest): string | null {
  const context = request.context as { playerId?: unknown }
  const playerId = typeof context?.playerId === 'string' ? context.playerId.trim() : ''
  return playerId || null
}

export async function resolveConsumerConversation(
  request: StructuredModelRequest,
): Promise<ConsumerConversationHint> {
  const base: ConsumerConversationHint = { temporaryChat: true }
  if (request.operation !== 'calibrate_player_initialization') return base

  const playerId = playerIdFrom(request)
  const supabase = client()
  if (!playerId || !supabase) return base

  const { data, error } = await supabase
    .from('ai_reasoning_sessions')
    .select('conversation_ref,temporary_chat,provider_id,status')
    .eq('user_id', playerId)
    .eq('phase_key', INITIALIZATION_PHASE_KEY)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw new Error(`load initialization reasoning session: ${error.message}`)
  if (!data || data.provider_id !== CONSUMER_PROVIDER_ID || data.temporary_chat !== true) return base

  const conversationRef = typeof data.conversation_ref === 'string' ? data.conversation_ref.trim() : ''
  return conversationRef ? { temporaryChat: true, conversationRef } : base
}

export async function persistInitializationReasoningSession(input: {
  playerId: string
  readiness: 'ask' | 'ready'
  conversationRef?: string
}): Promise<void> {
  const supabase = client()
  if (!supabase) return

  if (input.readiness === 'ready') {
    const now = new Date().toISOString()
    const { error } = await supabase
      .from('ai_reasoning_sessions')
      .update({
        status: 'closed',
        closed_at: now,
        last_used_at: now,
        updated_at: now,
      })
      .eq('user_id', input.playerId)
      .eq('phase_key', INITIALIZATION_PHASE_KEY)
      .eq('status', 'active')
    if (error) throw new Error(`close initialization reasoning session: ${error.message}`)
    return
  }

  const conversationRef = input.conversationRef?.trim()
  if (!conversationRef) return

  const now = new Date().toISOString()
  const { error } = await supabase
    .from('ai_reasoning_sessions')
    .upsert({
      user_id: input.playerId,
      phase_key: INITIALIZATION_PHASE_KEY,
      status: 'active',
      provider_id: CONSUMER_PROVIDER_ID,
      conversation_ref: conversationRef,
      temporary_chat: true,
      last_used_at: now,
      closed_at: null,
      updated_at: now,
    }, { onConflict: 'user_id,phase_key' })
  if (error) throw new Error(`persist initialization reasoning session: ${error.message}`)
}
