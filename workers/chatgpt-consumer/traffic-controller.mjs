import { createClient } from '@supabase/supabase-js'

const CLIENT_KIND = process.env.SUPERHUMAN_CHATGPT_TRAFFIC_KIND === 'qa' ? 'qa' : 'production'
const WORKER_ID = process.env.SUPERHUMAN_QA_WORKER_ID
  || process.env.SUPERHUMAN_WORKER_ID
  || process.env.AI_WORKER_ID
  || `chatgpt-${CLIENT_KIND}:${process.pid}`
const LEASE_SECONDS = Number(process.env.SUPERHUMAN_CHATGPT_TRAFFIC_LEASE_SECONDS || 600)
const POLL_MS = Number(process.env.SUPERHUMAN_CHATGPT_TRAFFIC_POLL_MS || 2500)
const QA_BASE_INTERVAL_SECONDS = Number(process.env.SUPERHUMAN_QA_BASE_INTERVAL_SECONDS || 60)

let client = null

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function serviceKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

function controllerClient() {
  if (client) return client
  const url = process.env.SUPABASE_URL
  const key = serviceKey()
  if (!url || !key) throw new Error('ChatGPT traffic controller requires SUPABASE_URL and service key')
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return client
}

function rowFrom(data) {
  if (Array.isArray(data)) return data[0] || null
  return data && typeof data === 'object' ? data : null
}

function retryAfterSeconds(row, fallback = 5) {
  const value = Number(row?.retry_after_seconds ?? fallback)
  return Number.isFinite(value) ? Math.max(1, Math.ceil(value)) : fallback
}

export async function acquireChatGptTrafficSlot({ correlationId, waitBudgetMs = 10 * 60_000 }) {
  const holderId = `${CLIENT_KIND}:${WORKER_ID}:${correlationId || Date.now()}`
  const deadline = Date.now() + Math.max(5_000, Number(waitBudgetMs || 0))
  const supabase = controllerClient()

  while (Date.now() < deadline) {
    const { data, error } = await supabase.rpc('acquire_chatgpt_traffic_slot', {
      p_client_kind: CLIENT_KIND,
      p_holder_id: holderId,
      p_lease_seconds: Math.max(60, Math.min(900, LEASE_SECONDS)),
    })
    if (error) throw new Error(`acquire ChatGPT traffic slot: ${error.message}`)
    const row = rowFrom(data)
    if (row?.granted === true) return { holderId, row }

    const retryAfter = retryAfterSeconds(row)
    const reason = String(row?.reason || 'busy')

    // Production is allowed to wait through the short shared cooldown so a player job
    // does not get turned into an unnecessarily long retry. QA is never allowed to
    // sit on a claimed iteration through a provider cooldown.
    if (CLIENT_KIND === 'qa' && ['global_cooldown', 'qa_cooldown'].includes(reason)) {
      return { holderId, row, blockedCode: 'provider_rate_limited', retryAfterSeconds: retryAfter }
    }

    const remaining = deadline - Date.now()
    if (remaining <= 1000) {
      return { holderId, row, blockedCode: 'traffic_deferred', retryAfterSeconds: retryAfter }
    }
    await sleep(Math.min(POLL_MS, remaining - 250))
  }

  return { holderId, row: null, blockedCode: 'traffic_deferred', retryAfterSeconds: 5 }
}

export async function recordChatGptTrafficResult(holderId, result) {
  const supabase = controllerClient()
  const { data, error } = await supabase.rpc('record_chatgpt_traffic_result', {
    p_client_kind: CLIENT_KIND,
    p_holder_id: holderId,
    p_result: result,
    p_qa_base_interval_seconds: Math.max(30, Math.min(300, QA_BASE_INTERVAL_SECONDS)),
  })
  if (error) {
    console.error(`[traffic-controller] record failed kind=${CLIENT_KIND} result=${result}: ${error.message}`)
    return null
  }
  return data
}

export function chatGptTrafficRuntimeSummary() {
  return `trafficController=shared kind=${CLIENT_KIND} concurrency=1 qaBaseInterval=${QA_BASE_INTERVAL_SECONDS}s`
}
