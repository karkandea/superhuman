import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { ChatGptConsumerWebProvider } from '../../lib/ai/chatgpt-consumer-provider.ts'
import { BoundedPlayerContextRetriever } from '../../lib/context-retrieval.ts'
import {
  assessKnowledgeMateriality,
  derivePlayerUnderstanding,
  generateDailyQuests,
  generateSystemInterrupt,
} from '../../lib/ai/orchestrator.ts'
import {
  createSupabaseDailyQuestRepository,
  createSupabaseMaterialityRepository,
  createSupabasePlayerContextStore,
  createSupabaseUnderstandingRepository,
} from '../../lib/supabase/progression-store.ts'

const CHATGPT_URL = 'https://chatgpt.com/'
const WORKER_ID = process.env.SUPERHUMAN_WORKER_ID || process.env.AI_WORKER_ID || `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const POLL_MS = Number(process.env.SUPERHUMAN_WORKER_POLL_MS || 2500)
const LEASE_SECONDS = Number(process.env.SUPERHUMAN_WORKER_LEASE_SECONDS || 300)
const GENERATION_TIMEOUT_MS = Number(process.env.CHATGPT_GENERATION_TIMEOUT_MS || 180000)
const PROFILE_DIR = process.env.CHATGPT_BROWSER_PROFILE_DIR || path.join(os.homedir(), '.superhuman', 'chatgpt-profile')
const CHROME_BIN = process.env.CHATGPT_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP_PORT = Number(process.env.CHATGPT_CDP_PORT || 9222)
const CDP_URL = process.env.CHATGPT_CDP_URL || `http://127.0.0.1:${CDP_PORT}`
const HEADLESS = process.env.CHATGPT_HEADLESS !== 'false'
const MAX_PENDING_KNOWLEDGE = Number(process.env.SUPERHUMAN_PENDING_KNOWLEDGE_LIMIT || 12)
const MAX_MATERIALITY_UPDATES = Number(process.env.SUPERHUMAN_MATERIALITY_LIMIT || 12)

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
  if (!data || typeof data !== 'object' || !data.id) return null
  return data
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.isVisible().catch(() => false)) return locator
  }
  return null
}

async function throwIfProviderRateLimited(page) {
  const modal = page.locator('[data-testid="modal-conversation-history-rate-limit"]').first()
  if (await modal.isVisible().catch(() => false)) {
    throw new WorkerError(
      'provider_rate_limited',
      'ChatGPT temporarily rate-limited the browser session. Player context is safe and the job will retry later.',
      true,
    )
  }
}

async function waitForComposer(page, deadline) {
  const selectors = [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]',
  ]

  while (Date.now() < deadline) {
    await throwIfProviderRateLimited(page)
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
    await throwIfProviderRateLimited(page)
    if (await assistantMessages.count() > previousCount) break
    await sleep(500)
  }

  if (await assistantMessages.count() <= previousCount) {
    throw new WorkerError('generation_timeout', 'ChatGPT did not start an assistant response before timeout', true)
  }

  let previousText = ''
  let stablePasses = 0

  while (Date.now() < deadline) {
    await throwIfProviderRateLimited(page)
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

let connectedBrowser = null
let spawnedChrome = null

async function cdpReady() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`)
    return response.ok
  } catch {
    return false
  }
}

async function waitForCdp(deadline) {
  while (Date.now() < deadline) {
    if (await cdpReady()) return
    await sleep(250)
  }
  throw new WorkerError('browser_start_failed', `Chrome CDP did not become ready at ${CDP_URL}`, true)
}

async function ensureChromeRunning() {
  if (await cdpReady()) return

  await fs.mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(PROFILE_DIR, 0o700).catch(() => {})

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(HEADLESS ? ['--headless=new'] : []),
    CHATGPT_URL,
  ]

  spawnedChrome = spawn(CHROME_BIN, args, { detached: true, stdio: 'ignore' })
  spawnedChrome.unref()
  await waitForCdp(Date.now() + 20_000)
}

async function connectBrowser() {
  if (connectedBrowser?.isConnected()) return connectedBrowser
  await ensureChromeRunning()
  connectedBrowser = await chromium.connectOverCDP(CDP_URL)
  connectedBrowser.on('disconnected', () => { connectedBrowser = null })
  return connectedBrowser
}

async function chatGptContext() {
  const browser = await connectBrowser()
  const context = browser.contexts()[0]
  if (!context) throw new WorkerError('browser_context_missing', 'Dedicated Chrome has no browser context', true)
  return context
}

class PlaywrightChatGptTransport {
  async execute({ prompt, timeoutMs }) {
    const context = await chatGptContext()
    const page = await context.newPage()

    try {
      const deadline = Date.now() + timeoutMs
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 45000) })
      await throwIfProviderRateLimited(page)

      const composer = await waitForComposer(page, deadline)
      const assistantMessages = page.locator('[data-message-author-role="assistant"]')
      const previousCount = await assistantMessages.count()

      await composer.fill(prompt)
      await throwIfProviderRateLimited(page)

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
      await page.close().catch(() => {})
    }
  }
}

async function loginMode() {
  const context = await chatGptContext()
  let page = context.pages().find(candidate => candidate.url().includes('chatgpt.com'))
  if (!page) page = await context.newPage()
  if (!page.url().includes('chatgpt.com')) await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' })

  process.stdout.write(`Connected to dedicated Chrome at ${CDP_URL}\nVerifying the current ChatGPT session without reopening the profile.\n`)
  await waitForComposer(page, Date.now() + 60_000)
  process.stdout.write('ChatGPT session detected. Dedicated Chrome is ready for worker use.\n')
  process.exit(0)
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

async function pendingMaterialityKnowledgeIds(client, playerId) {
  const { data, error } = await client
    .from('knowledge_entries')
    .select('id')
    .eq('user_id', playerId)
    .eq('processing_status', 'processed')
    .in('materiality_status', ['pending', 'failed'])
    .order('updated_at', { ascending: true })
    .limit(MAX_MATERIALITY_UPDATES)
  if (error) throw new Error(`load pending materiality knowledge: ${error.message}`)
  return (data || []).map(row => row.id)
}

function mapAssessment(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    knowledgeEntryId: String(row.knowledge_entry_id),
    targetDate: String(row.target_date),
    isMaterial: Boolean(row.is_material),
    level: row.level,
    confidence: Number(row.confidence),
    reason: String(row.reason),
    affectedQuestIds: Array.isArray(row.affected_quest_ids) ? row.affected_quest_ids.map(String) : [],
    sourceSignalIds: Array.isArray(row.source_signal_ids) ? row.source_signal_ids.map(String) : [],
    recommendedAction: row.recommended_action,
    urgency: row.urgency,
    disposition: row.disposition,
    createdAt: String(row.created_at),
  }
}

async function assessmentsAwaitingInterrupt(client, playerId, date) {
  const { data, error } = await client
    .from('materiality_assessments')
    .select('*,quest_interrupts(id)')
    .eq('user_id', playerId)
    .eq('target_date', date)
    .in('disposition', ['suggest', 'auto_interrupt'])
    .order('created_at', { ascending: true })
  if (error) throw new Error(`load pending interrupt assessments: ${error.message}`)
  return (data || [])
    .filter(row => !Array.isArray(row.quest_interrupts) || row.quest_interrupts.length === 0)
    .map(mapAssessment)
}

async function markBaselineKnowledgeNotRequired(client, playerId) {
  const { error } = await client
    .from('knowledge_entries')
    .update({ materiality_status: 'not_required' })
    .eq('user_id', playerId)
    .eq('processing_status', 'processed')
    .in('materiality_status', ['pending', 'failed'])
  if (error) throw new Error(`mark baseline materiality not required: ${error.message}`)
}

function classifyError(error) {
  if (error instanceof WorkerError) return error
  const message = error instanceof Error ? error.message : String(error)

  if (/evidence-backed player signals|No player knowledge was retrieved|At least one knowledge entry/.test(message)) {
    return new WorkerError('insufficient_context', message, false)
  }
  if (/correlation mismatch|operation mismatch|schema version mismatch|malformed JSON|parseable JSON|sourceSignalIds|sourceKnowledgeEntryIds|outside retrieved context|Materiality|materiality|System Interrupt|Interrupt action|interrupt plan|affectedQuestIds|urgency|recommendedAction/.test(message)) {
    return new WorkerError('model_output_invalid', message, true)
  }
  if (/timeout|fetch failed|network|connection|temporar/i.test(message)) {
    return new WorkerError('transient_transport_error', message, true)
  }
  return new WorkerError('inference_failed', message, true)
}

async function scheduleRetry(client, job, error, refs) {
  const delaySeconds = error.code === 'provider_rate_limited'
    ? 120
    : Math.min(60, 2 ** Number(job.attempt_count || 1) * 3)
  const { error: rpcError } = await client.rpc('schedule_ai_inference_retry', {
    p_job_id: job.id,
    p_worker_id: WORKER_ID,
    p_error_code: error.code,
    p_error_message: error.message,
    p_delay_seconds: delaySeconds,
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
  const materialityRepository = createSupabaseMaterialityRepository(client)

  const heartbeatTimer = setInterval(() => {
    heartbeat(client, job.id).catch(error => console.error(`[heartbeat] ${error.message}`))
  }, Math.max(15_000, Math.floor(LEASE_SECONDS * 500)))

  try {
    const questsBefore = await dailyQuestRepository.findForDate(job.user_id, job.target_date)
    const hadDailyPlan = questsBefore.length > 0
    const knowledgeIds = await pendingKnowledgeIds(client, job.user_id)
    let derivedCount = 0
    let materialityCount = 0
    let noChangeCount = 0
    let suggestedInterruptCount = 0
    let appliedInterruptCount = 0

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

    if (hadDailyPlan) {
      const materialityIds = await pendingMaterialityKnowledgeIds(client, job.user_id)
      for (const knowledgeEntryId of materialityIds) {
        const assessed = await assessKnowledgeMateriality({
          provider,
          contextRetriever,
          repository: materialityRepository,
        }, {
          playerId: job.user_id,
          knowledgeEntryId,
          date: job.target_date,
        })
        materialityCount += assessed.source === 'assessed' ? 1 : 0
        if (assessed.assessment.disposition === 'no_change') noChangeCount += 1
      }

      const pendingInterrupts = await assessmentsAwaitingInterrupt(client, job.user_id, job.target_date)
      for (const assessment of pendingInterrupts) {
        const generated = await generateSystemInterrupt({
          provider,
          contextRetriever,
          repository: materialityRepository,
        }, {
          playerId: job.user_id,
          knowledgeEntryId: assessment.knowledgeEntryId,
          date: job.target_date,
          assessment,
        })
        if (generated.interrupt.status === 'applied') appliedInterruptCount += 1
        else suggestedInterruptCount += 1
      }
    }

    const generated = await generateDailyQuests({
      provider,
      contextRetriever,
      repository: dailyQuestRepository,
    }, {
      playerId: job.user_id,
      date: job.target_date,
    })

    if (!hadDailyPlan && generated.quests.length > 0) {
      await markBaselineKnowledgeNotRequired(client, job.user_id)
    }

    const refs = provider.consumeConversationRefs()
    await completeJob(client, job, 'succeeded', refs, {
      derivedUnderstandingCount: derivedCount,
      materialityAssessmentCount: materialityCount,
      materialityNoChangeCount: noChangeCount,
      suggestedInterruptCount,
      appliedInterruptCount,
      questCount: generated.quests.length,
      questSource: generated.source,
      targetDate: job.target_date,
    })

    console.log(`[job ${job.id}] succeeded: ${generated.quests.length} quests (${generated.source}); materiality=${materialityCount}; interrupts=${appliedInterruptCount} applied/${suggestedInterruptCount} suggested`)
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
  console.log(`ChatGPT profile: ${PROFILE_DIR}; cdp=${CDP_URL}; headless=${HEADLESS}`)

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
