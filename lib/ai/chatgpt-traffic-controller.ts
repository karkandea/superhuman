import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type ChatGptTrafficClientKind = 'production' | 'qa'
export type ChatGptTrafficResult = 'success' | 'rate_limited' | 'error'

interface TrafficSlotRow {
  granted?: boolean
  reason?: string
  retry_after_seconds?: number
  cooldown_until?: string | null
  qa_cooldown_until?: string | null
  qa_next_allowed_at?: string | null
  rate_limit_streak?: number
}

export class ChatGptTrafficError extends Error {
  readonly retryable = true

  constructor(
    readonly code: 'provider_rate_limited' | 'traffic_deferred',
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message)
    this.name = 'ChatGptTrafficError'
  }
}

const TEST_MODE = process.env.SUPERHUMAN_TEST_MODE === '1'
const CLIENT_KIND: ChatGptTrafficClientKind = process.env.SUPERHUMAN_CHATGPT_TRAFFIC_KIND === 'qa' ? 'qa' : 'production'
const WORKER_ID = process.env.SUPERHUMAN_QA_WORKER_ID
  || process.env.SUPERHUMAN_WORKER_ID
  || process.env.AI_WORKER_ID
  || `chatgpt-${CLIENT_KIND}:${process.pid}`
const LEASE_SECONDS = boundedNumber(process.env.SUPERHUMAN_CHATGPT_TRAFFIC_LEASE_SECONDS, 600, 60, 900)
const POLL_MS = boundedNumber(process.env.SUPERHUMAN_CHATGPT_TRAFFIC_POLL_MS, 2500, 500, 5000)
const QA_BASE_INTERVAL_SECONDS = boundedNumber(process.env.SUPERHUMAN_QA_BASE_INTERVAL_SECONDS, 60, 30, 300)
const MAX_WAIT_MS = boundedNumber(process.env.SUPERHUMAN_CHATGPT_TRAFFIC_MAX_WAIT_MS, 10 * 60_000, 30_000, 15 * 60_000)

let sessionClient: SupabaseClient | null = null

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function serviceKey(): string {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

function client(): SupabaseClient {
  if (sessionClient) return sessionClient
  const url = process.env.SUPABASE_URL
  const key = serviceKey()
  if (!url || !key) throw new Error('ChatGPT traffic controller requires SUPABASE_URL and service-role credentials')
  sessionClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return sessionClient
}

function normalizeRow(data: unknown): TrafficSlotRow | null {
  if (Array.isArray(data)) return (data[0] as TrafficSlotRow | undefined) ?? null
  return data && typeof data === 'object' ? data as TrafficSlotRow : null
}

function retryAfterSeconds(row: TrafficSlotRow | null, fallback = 5): number {
  const parsed = Number(row?.retry_after_seconds ?? fallback)
  return Number.isFinite(parsed) ? Math.max(1, Math.ceil(parsed)) : fallback
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function acquireChatGptTrafficSlot(correlationId: string): Promise<{ holderId: string }> {
  if (TEST_MODE) return { holderId: `test:${correlationId}` }

  const holderId = `${CLIENT_KIND}:${WORKER_ID}:${correlationId}`
  const deadline = Date.now() + MAX_WAIT_MS
  const supabase = client()

  while (Date.now() < deadline) {
    const { data, error } = await supabase.rpc('acquire_chatgpt_traffic_slot', {
      p_client_kind: CLIENT_KIND,
      p_holder_id: holderId,
      p_lease_seconds: LEASE_SECONDS,
    })
    if (error) throw new Error(`acquire ChatGPT traffic slot: ${error.message}`)

    const row = normalizeRow(data)
    if (row?.granted === true) return { holderId }

    const reason = String(row?.reason || 'busy')
    const retryAfter = retryAfterSeconds(row)

    // QA never waits while the shared account is cooling down. It returns the
    // iteration to its own long cooldown path without sending another prompt.
    if (CLIENT_KIND === 'qa' && (reason === 'global_cooldown' || reason === 'qa_cooldown')) {
      throw new ChatGptTrafficError(
        'provider_rate_limited',
        `Shared ChatGPT traffic circuit is cooling down; QA must retry later (${retryAfter}s)`,
        retryAfter,
      )
    }

    const remaining = deadline - Date.now()
    if (remaining <= 1000) {
      throw new ChatGptTrafficError(
        'traffic_deferred',
        `ChatGPT traffic was temporarily deferred by the shared controller (${reason})`,
        retryAfter,
      )
    }

    await sleep(Math.min(POLL_MS, remaining - 250))
  }

  throw new ChatGptTrafficError('traffic_deferred', 'ChatGPT traffic was temporarily deferred by the shared controller', 5)
}

export async function recordChatGptTrafficResult(holderId: string, result: ChatGptTrafficResult): Promise<Record<string, unknown> | null> {
  if (TEST_MODE) return null

  const { data, error } = await client().rpc('record_chatgpt_traffic_result', {
    p_client_kind: CLIENT_KIND,
    p_holder_id: holderId,
    p_result: result,
    p_qa_base_interval_seconds: QA_BASE_INTERVAL_SECONDS,
  })
  if (error) {
    console.error(`[traffic-controller] record failed kind=${CLIENT_KIND} result=${result}: ${error.message}`)
    return null
  }
  return data && typeof data === 'object' ? data as Record<string, unknown> : null
}

export function chatGptTrafficRuntimeSummary(): string {
  return `trafficController=shared kind=${CLIENT_KIND} concurrency=1 qaBaseInterval=${QA_BASE_INTERVAL_SECONDS}s`
}
