/* eslint-disable */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

import { ChatGptConsumerWebProvider } from '../../lib/ai/chatgpt-consumer-provider.ts'
import { BoundedPlayerContextRetriever } from '../../lib/context-retrieval.ts'
import { derivePlayerUnderstanding, generateDailyQuests } from '../../lib/ai/orchestrator.ts'
import {
  createSupabaseDailyQuestRepository,
  createSupabasePlayerContextStore,
  createSupabaseUnderstandingRepository,
} from '../../lib/supabase/progression-store.ts'

const CHATGPT_URL = 'https://chatgpt.com/'
const WORKER_ID = process.env.SUPERHUMAN_WORKER_ID || `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const POLL_MS = Number(process.env.SUPERHUMAN_WORKER_POLL_MS || 2500)
const LEASE_SECONDS = Number(process.env.SUPERHUMAN_WORKER_LEASE_SECONDS || 300)
const GENERATION_TIMEOUT_MS = Number(process.env.CHATGPT_GENERATION_TIMEOUT_MS || 180000)
const PROFILE_DIR = process.env.CHATGPT_BROWSER_PROFILE_DIR || path.join(os.homedir(), '.superhuman', 'chatgpt-profile')
const HEADLESS = process.env.CHATGPT_HEADLESS !== 'false'
const MAX_PENDING_KNOWLEDGE = Number(process.env.SUPERHUMAN_PENDING_KNOWLEDGE_LIMIT || 12)

class WorkerError extends Error {
  constructor(code, message, retryable = true) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.retryable = retryable
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function serviceKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

function normalizeRpcRow(data) {
  if (Array.isArray(data)) return data[0] || null
  return data && typeof data === 'object' ? data : null
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.isVisible().catch(() => false)) return locator
  }
  return null
}

async function waitForComposer(page, deadline) {
  const selectors = [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]',
  ]

  while (Date.now() < deadline) {
    const composer = await firstVisible(page, selectors)
    if (composer) return composer

    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase()
    const url = page.url().toLowerCase()
    if (url.includes('/auth/login') || /log in|sign up/.test(body)) {
      throw new WorkerError('browser_auth_required', 'ChatGPT browser session is not authenticated', false)
    }
    if (/verify you are human|checking your browser|security check/.test(body)) {
      throw new WorkerError('browser_challenge', 'ChatGPT browser challenge blocked the worker', true)
    }
    await sleep(500)
  }

  throw new WorkerError('composer_not_found', 'ChatGPT prompt composer was not found', true)
}

async function waitForAssistantResponse(page, previousCount, deadline) {
  const assistantMessages = page.locator('[data-message-author-role="assistant"]')

  while (Date.now() < deadline) {
    if (await assistantMessages.count() > previousCount) break
    await sleep(500)
  }

  if (await assistantMessages.count() <= previousCount) {
    throw new WorkerError('generation_timeout', 'ChatGPT did not start an assistant response before timeout', true)
  }

  let previousText = ''
  let stablePasses = 0

  while (Date.now() < deadline) {
    const count = await assistantMessages.count()
    const latest = assistantMessages.nth(Math.max(0, count - 1))
    const text = (await latest.innerText().catch(() => '')).trim()
    const stopVisible = await firstVisible(page, [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button:has-text("Stop generating")',
    ])

    if (text && text === previousText && !stopVisible) {
      stablePasses += 1
    } else {
      stablePasses = 0
    }

    if (stablePasses >= 3) return text
    previousText = text
    await sleep(800)
  }

  throw new WorkerError('generation_timeout', 'ChatGPT response did not finish before timeout', true)
}

class PlaywrightChatGptTransport {
  async execute({ prompt, timeoutMs }) {
    await fs.mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 })
    await fs.chmod(PROFILE_DIR, 0o700).catch(() => {})

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS,
      viewport: { width: 1365, height: 900 },
      locale: 'en-US',
    })

    try {
      const page = context.pages()[0] || await context.newPage()
      const deadline = Date.now() + timeoutMs
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 45000) })

      const composer = await waitForComposer(page, deadline)
      const assistantMessages = page.locator('[data-message-author-role="assistant"]')
      const previousCount = await assistantMessages.count()

      await composer.fill(prompt)

      const sendButton = await firstVisible(page, [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
      ])

      if (sendButton) await sendButton.click()
      else await composer.press('Enter')

      const text = await waitForAssistantResponse(page, previousCount, deadline)
      const match = page.url().match(/\/c\/([^/?#]+)/)

      return {
        text,
        conversationRef: match?.[1],
        modelLabel: 'chatgpt-consumer-auto',
      }
    } finally {
      await context.close()
    }
  }
}

async function loginMode() {
  await fs.mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 })
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1365, height: 900 },
  })

  const page = context.pages()[0] || await context.newPage()
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' })
  process.stdout.write(`Open browser profile: ${PROFILE_DIR}\nComplete ChatGPT login once. The process exits automatically when the composer is available.\n`)

  try {
    await waitForComposer(page, Date.now() + 10 * 60_000)
    process.stdout.write('ChatGPT session detected. Browser profile is ready for headless worker use.\n')
  } finally {
    await context.close()
  }
}

function createSupabase() {
  const url = requiredEnv('SUPABASE_URL')
  const key = serviceKey()
  if (!key) throw new Error('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function claimJob(client) {
  const { data, error } = await client.rpc('claim_ai_inference_job', {
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
  })
  if (error) throw new Error(`claim job: ${error.message}`)
  return normalizeRpcRow(data)
}

async function heartbeat(client, jobId) {
  const { error } = await client.rpc('heartbeat_ai_inference_job', {
    p_job_id: jobId,
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
  })
  if (error) throw new Error(`heartbeat job: ${error.message}`)
}

async function pendingKnowledgeIds(client, playerId) {
  const { data, error } = await client
    .from('knowledge_entries')
    .select('id')
    .eq('user_id', playerId)
    .in('processing_status', ['pending', 'failed'])
    .order('created_at', { ascending: true })
    .limit(MAX_PENDING_KNOWLEDGE)
  if (error) throw new Error(`load pending knowledge: ${error.message}`)
  return (data || []).map(row => row.id)
}

function classifyError(error) {
  if (error instanceof WorkerError) return error
  const message = error instanceof Error ? error.message : String(error)

  if (/evidence-backed player signals|No player knowledge was retrieved|At least one knowledge entry/.test(message)) {
    return new WorkerError('insufficient_context', message, false)
  }
  if (/correlation mismatch|operation mismatch|schema version mismatch|malformed JSON|parseable JSON|sourceSignalIds|sourceKnowledgeEntryIds|outside retrieved context/.test(message)) {
    return new WorkerError('model_output_invalid', message, true)
  }
  if (/timeout|fetch failed|network|connection|temporar/i.test(message)) {
    return new WorkerError('transient_transport_error', message, true)
  }
  return new WorkerError('inference_failed', message, true)
}

async function scheduleRetry(client, job, error, refs) {
  const { error: rpcError } = await client.rpc('schedule_ai_inference_retry', {
    p_job_id: job.id,
    p_worker_id: WORKER_ID,
    p_error_code: error.code,
    p_error_message: error.message,
    p_delay_seconds: Math.min(60, 2 ** Number(job.attempt_count || 1) * 3),
    p_provider_id: 'chatgpt-consumer-web',
    p_provider_conversation_refs: refs,
  })
  if (rpcError) throw new Error(`schedule retry: ${rpcError.message}`)
}

async function completeJob(client, job, status, refs, summary = {}, error = null) {
  const { error: rpcError } = await client.rpc('complete_ai_inference_job', {
    p_job_id: job.id,
    p_worker_id: WORKER_ID,
    p_status: status,
    p_provider_id: 'chatgpt-consumer-web',
    p_provider_conversation_refs: refs,
    p_result_summary: summary,
    p_error_code: error?.code || null,
    p_error_message: error?.message || null,
  })
  if (rpcError) throw new Error(`complete job: ${rpcError.message}`)
}

async function processJob(client, job) {
  const transport = new PlaywrightChatGptTransport()
  const provider = new ChatGptConsumerWebProvider(transport, {
    timeoutMs: GENERATION_TIMEOUT_MS,
    idFactory: () => `${job.correlation_id}:${randomUUID()}`,
  })
  const contextStore = createSupabasePlayerContextStore(client)
  const contextRetriever = new BoundedPlayerContextRetriever(contextStore)
  const understandingRepository = createSupabaseUnderstandingRepository(client)
  const dailyQuestRepository = createSupabaseDailyQuestRepository(client)

  const heartbeatTimer = setInterval(() => {
    heartbeat(client, job.id).catch(error => console.error(`[heartbeat] ${error.message}`))
  }, Math.max(15_000, Math.floor(LEASE_SECONDS * 500)))

  try {
    const knowledgeIds = await pendingKnowledgeIds(client, job.user_id)
    let derivedCount = 0

    if (knowledgeIds.length > 0) {
      const derived = await derivePlayerUnderstanding({
        provider,
        contextRetriever,
        repository: understandingRepository,
      }, {
        playerId: job.user_id,
        knowledgeEntryIds: knowledgeIds,
        limit: MAX_PENDING_KNOWLEDGE,
      })
      derivedCount = derived.length
    }

    const generated = await generateDailyQuests({
      provider,
      contextRetriever,
      repository: dailyQuestRepository,
    }, {
      playerId: job.user_id,
      date: job.target_date,
    })

    const refs = provider.consumeConversationRefs()
    await completeJob(client, job, 'succeeded', refs, {
      derivedUnderstandingCount: derivedCount,
      questCount: generated.quests.length,
      questSource: generated.source,
      targetDate: job.target_date,
    })

    console.log(`[job ${job.id}] succeeded: ${generated.quests.length} quests (${generated.source})`)
  } catch (rawError) {
    const error = classifyError(rawError)
    const refs = provider.consumeConversationRefs()

    if (error.code === 'browser_auth_required') {
      await completeJob(client, job, 'blocked_auth', refs, {}, error)
      console.error(`[job ${job.id}] blocked: ${error.message}`)
      return
    }

    if (error.retryable && Number(job.attempt_count || 0) < Number(job.max_attempts || 3)) {
      await scheduleRetry(client, job, error, refs)
      console.error(`[job ${job.id}] retry scheduled: ${error.code}: ${error.message}`)
      return
    }

    await completeJob(client, job, 'failed', refs, {}, error)
    console.error(`[job ${job.id}] failed: ${error.code}: ${error.message}`)
  } finally {
    clearInterval(heartbeatTimer)
  }
}

async function main() {
  if (process.argv.includes('--login')) {
    await loginMode()
    return
  }

  const client = createSupabase()
  const once = process.argv.includes('--once')
  console.log(`Superhuman ChatGPT consumer worker online as ${WORKER_ID}`)
  console.log(`ChatGPT profile: ${PROFILE_DIR}; headless=${HEADLESS}`)

  do {
    const job = await claimJob(client)
    if (!job) {
      if (once) return
      await sleep(POLL_MS)
      continue
    }

    await processJob(client, job)
    if (once) return
  } while (true)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
