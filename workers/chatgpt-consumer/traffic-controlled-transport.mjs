import { randomUUID } from 'node:crypto'

import { PlaywrightChatGptTransport, WorkerError } from './browser-transport.mjs'

const DEFAULT_LEASE_SECONDS = Number(process.env.SUPERHUMAN_CHATGPT_TRAFFIC_LEASE_SECONDS || 600)
const DEFAULT_POLL_MS = Number(process.env.SUPERHUMAN_CHATGPT_TRAFFIC_POLL_MS || 2500)
const DEFAULT_QA_BASE_INTERVAL_SECONDS = Number(process.env.SUPERHUMAN_QA_BASE_INTERVAL_SECONDS || 60)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function rpcRow(data) {
  if (Array.isArray(data)) return data[0] || null
  return data && typeof data === 'object' ? data : null
}

function retryAfterSeconds(row, fallback = 5) {
  const value = Number(row?.retry_after_seconds ?? row?.retryAfterSeconds ?? fallback)
  return Number.isFinite(value) ? Math.max(1, Math.ceil(value)) : fallback
}

function trafficError(code, message, retryAfter) {
  const error = new WorkerError(code, message, true)
  error.retryAfterSeconds = Math.max(1, Number(retryAfter || 1))
  return error
}

export class TrafficControlledChatGptTransport {
  constructor({
    client,
    clientKind,
    workerId,
    inner = new PlaywrightChatGptTransport(),
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    pollMs = DEFAULT_POLL_MS,
    qaBaseIntervalSeconds = DEFAULT_QA_BASE_INTERVAL_SECONDS,
  }) {
    if (!client) throw new Error('TrafficControlledChatGptTransport requires a Supabase client')
    if (!['production', 'qa'].includes(clientKind)) throw new Error(`Unsupported traffic client kind: ${clientKind}`)
    if (!workerId) throw new Error('TrafficControlledChatGptTransport requires workerId')
    this.client = client
    this.clientKind = clientKind
    this.workerId = workerId
    this.inner = inner
    this.leaseSeconds = Math.max(60, Math.min(900, Number(leaseSeconds || DEFAULT_LEASE_SECONDS)))
    this.pollMs = Math.max(500, Math.min(5000, Number(pollMs || DEFAULT_POLL_MS)))
    this.qaBaseIntervalSeconds = Math.max(30, Math.min(300, Number(qaBaseIntervalSeconds || DEFAULT_QA_BASE_INTERVAL_SECONDS)))
  }

  async acquire(holderId, deadline) {
    while (Date.now() < deadline) {
      const { data, error } = await this.client.rpc('acquire_chatgpt_traffic_slot', {
        p_client_kind: this.clientKind,
        p_holder_id: holderId,
        p_lease_seconds: this.leaseSeconds,
      })
      if (error) throw new Error(`acquire ChatGPT traffic slot: ${error.message}`)
      const row = rpcRow(data)
      if (row?.granted === true) return row

      const reason = String(row?.reason || 'busy')
      const retryAfter = retryAfterSeconds(row)
      if (reason === 'global_cooldown') {
        throw trafficError(
          'provider_rate_limited',
          `Shared ChatGPT traffic circuit is cooling down; retry after about ${retryAfter}s`,
          retryAfter,
        )
      }

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 1000) {
        throw trafficError(
          'traffic_deferred',
          `Shared ChatGPT traffic slot stayed unavailable (${reason})`,
          retryAfter,
        )
      }
      await sleep(Math.min(this.pollMs, remainingMs - 250))
    }

    throw trafficError('traffic_deferred', 'Shared ChatGPT traffic slot wait expired', 5)
  }

  async record(holderId, result) {
    const { data, error } = await this.client.rpc('record_chatgpt_traffic_result', {
      p_client_kind: this.clientKind,
      p_holder_id: holderId,
      p_result: result,
      p_qa_base_interval_seconds: this.qaBaseIntervalSeconds,
    })
    if (error) {
      console.error(`[traffic-controller] record result failed kind=${this.clientKind} result=${result}: ${error.message}`)
      return null
    }
    return data
  }

  async execute(input) {
    const holderId = `${this.clientKind}:${this.workerId}:${input.correlationId || randomUUID()}`
    const timeoutMs = Math.max(10_000, Number(input.timeoutMs || 180_000))
    const acquireDeadline = Date.now() + timeoutMs
    await this.acquire(holderId, acquireDeadline)

    try {
      const result = await this.inner.execute(input)
      await this.record(holderId, 'success')
      return result
    } catch (error) {
      if (error?.code === 'provider_rate_limited') {
        const state = await this.record(holderId, 'rate_limited')
        const retryAt = state?.cooldownUntil ? Date.parse(state.cooldownUntil) : NaN
        if (!Number.isFinite(Number(error.retryAfterSeconds)) && Number.isFinite(retryAt)) {
          error.retryAfterSeconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
        }
      } else {
        await this.record(holderId, 'error')
      }
      throw error
    }
  }
}

export function trafficControllerRuntimeSummary(kind) {
  return `trafficController=shared kind=${kind} concurrency=1 qaBaseInterval=${DEFAULT_QA_BASE_INTERVAL_SECONDS}s`
}
