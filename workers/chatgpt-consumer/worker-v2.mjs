import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { ChatGptConsumerWebProvider } from '../../lib/ai/chatgpt-consumer-provider.ts'
import { BoundedPlayerContextRetriever } from '../../lib/context-retrieval.ts'
import {
  derivePlayerUnderstandingDelta,
  generateDailyQuests,
  generateSystemInterrupt,
} from '../../lib/ai/orchestrator.ts'
import {
  MATERIALITY_BATCH_SCHEMA_VERSION,
  assessActivityMateriality,
  selectKnowledgeBatchByBytes,
} from '../../lib/activity-orchestration.ts'
import {
  createSupabaseDailyQuestRepository,
  createSupabaseMaterialityRepository,
  createSupabasePlayerContextStore,
  createSupabaseUnderstandingRepository,
} from '../../lib/supabase/progression-store.ts'
import {
  PlaywrightChatGptTransport,
  WorkerError,
  browserRuntimeSummary,
  loginMode,
} from './browser-transport.mjs'

const WORKER_ID = process.env.SUPERHUMAN_WORKER_ID || process.env.AI_WORKER_ID || `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const POLL_MS = Number(process.env.SUPERHUMAN_WORKER_POLL_MS || 2500)
const LEASE_SECONDS = Number(process.env.SUPERHUMAN_WORKER_LEASE_SECONDS || 300)
const GENERATION_TIMEOUT_MS = Number(process.env.CHATGPT_GENERATION_TIMEOUT_MS || 180000)
const KNOWLEDGE_BATCH_BUDGET_BYTES = Number(process.env.SUPERHUMAN_KNOWLEDGE_BATCH_BUDGET_BYTES || 24 * 1024)
const MATERIALITY_RAW_BUDGET_BYTES = Number(process.env.SUPERHUMAN_MATERIALITY_RAW_BUDGET_BYTES || 24 * 1024)
const KNOWLEDGE_SCAN_LIMIT = Number(process.env.SUPERHUMAN_KNOWLEDGE_SCAN_LIMIT || 200)
const AI_STAGE_PAUSE_MS = Number(process.env.SUPERHUMAN_AI_STAGE_PAUSE_MS || 5000)
const UNDERSTANDING_DELTA_VERSION = 'understanding-delta.v1'

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

function understandingDeltaBatchKey(knowledgeEntryIds) {
  const ids = [...new Set(knowledgeEntryIds)].sort()
  const digest = createHash('sha256')
    .update(`${UNDERSTANDING_DELTA_VERSION}\n${ids.join('\n')}`)
    .digest('hex')
  return `${UNDERSTANDING_DELTA_VERSION}:${digest}`
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

async function pendingKnowledgeBatch(client, playerId, cutoff) {
  let query = client
    .from('knowledge_entries')
    .select('id,raw_text,created_at')
    .eq('user_id', playerId)
    .in('processing_status', ['pending', 'failed'])
    .order('created_at', { ascending: true })
    .limit(KNOWLEDGE_SCAN_LIMIT)
  if (cutoff) query = query.lte('created_at', cutoff)

  const { data, error } = await query
  if (error) throw new Error(`load pending knowledge: ${error.message}`)
  const rows = (data || []).map(row => ({ id: String(row.id), raw_text: String(row.raw_text || '') }))
  return selectKnowledgeBatchByBytes(rows, KNOWLEDGE_BATCH_BUDGET_BYTES)
}

async function pendingKnowledgeCount(client, playerId, cutoff) {
  let query = client
    .from('knowledge_entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', playerId)
    .in('processing_status', ['pending', 'failed'])
  if (cutoff) query = query.lte('created_at', cutoff)
  const { count, error } = await query
  if (error) throw new Error(`count pending knowledge: ${error.message}`)
  return Number(count || 0)
}

async function pendingMaterialityKnowledgeIds(client, playerId, cutoff) {
  const ids = []
  const pageSize = 500
  let offset = 0

  while (true) {
    let query = client
      .from('knowledge_entries')
      .select('id,created_at')
      .eq('user_id', playerId)
      .eq('processing_status', 'processed')
      .in('materiality_status', ['pending', 'failed'])
      .order('created_at', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (cutoff) query = query.lte('created_at', cutoff)
    const { data, error } = await query
    if (error) throw new Error(`load pending activity materiality: ${error.message}`)
    const rows = data || []
    ids.push(...rows.map(row => String(row.id)))
    if (rows.length < pageSize) break
    offset += pageSize
  }

  return ids
}

function mapAssessment(row) {
  const primaryId = String(row.knowledge_entry_id)
  return {
    id: String(row.id),
    userId: String(row.user_id),
    knowledgeEntryId: primaryId,
    knowledgeEntryIds: Array.isArray(row.knowledge_entry_ids) ? row.knowledge_entry_ids.map(String) : [primaryId],
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

async function unresolvedBatchAssessment(client, playerId, date, startedAt) {
  let query = client
    .from('materiality_assessments')
    .select('*,quest_interrupts(id)')
    .eq('user_id', playerId)
    .eq('target_date', date)
    .eq('assessment_version', MATERIALITY_BATCH_SCHEMA_VERSION)
    .in('disposition', ['suggest', 'auto_interrupt'])
    .order('created_at', { ascending: false })
    .limit(10)
  if (startedAt) query = query.gte('created_at', startedAt)
  const { data, error } = await query
  if (error) throw new Error(`load unresolved activity materiality: ${error.message}`)
  const row = (data || []).find(item => !Array.isArray(item.quest_interrupts) || item.quest_interrupts.length === 0)
  return row ? mapAssessment(row) : null
}

async function markBaselineKnowledgeNotRequired(client, playerId, cutoff) {
  let query = client
    .from('knowledge_entries')
    .update({ materiality_status: 'not_required' })
    .eq('user_id', playerId)
    .eq('processing_status', 'processed')
    .in('materiality_status', ['pending', 'failed'])
  if (cutoff) query = query.lte('created_at', cutoff)
  const { error } = await query
  if (error) throw new Error(`mark baseline materiality not required: ${error.message}`)
}

function classifyError(error) {
  if (error instanceof WorkerError) return error
  const message = error instanceof Error ? error.message : String(error)

  if (/evidence-backed player signals|No player knowledge was retrieved|At least one knowledge entry/.test(message)) {
    return new WorkerError('insufficient_context', message, false)
  }
  if (/correlation mismatch|operation mismatch|schema version mismatch|malformed JSON|parseable JSON|sourceSignalIds|sourceKnowledgeEntryIds|targetUnderstandingId|outside retrieved context|outside current Player Brief|Understanding delta|Materiality|materiality|System Interrupt|Interrupt action|interrupt plan|affectedQuestIds|urgency|recommendedAction/.test(message)) {
    return new WorkerError('model_output_invalid', message, true)
  }
  if (/Player Brief is missing|Player brief changed before understanding delta persistence/.test(message)) {
    return new WorkerError('stale_player_brief', message, true)
  }
  if (/backlog did not drain|same knowledge batch repeated/.test(message)) {
    return new WorkerError('backlog_not_drained', message, true)
  }
  if (/timeout|fetch failed|network|connection|temporar/i.test(message)) {
    return new WorkerError('transient_transport_error', message, true)
  }
  return new WorkerError('inference_failed', message, true)
}

async function scheduleRetry(client, job, error, refs) {
  const delaySeconds = error.code === 'provider_rate_limited'
    ? 900
    : Math.min(60, 2 ** Number(job.attempt_count || 1) * 3)
  const { data, error: rpcError } = await client.rpc('schedule_ai_inference_retry', {
    p_job_id: job.id,
    p_worker_id: WORKER_ID,
    p_error_code: error.code,
    p_error_message: error.message,
    p_delay_seconds: delaySeconds,
    p_provider_id: 'chatgpt-consumer-web',
    p_provider_conversation_refs: refs,
  })
  if (rpcError) throw new Error(`schedule retry: ${rpcError.message}`)
  return normalizeRpcRow(data)
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
    const cutoff = job.window_cutoff_at || new Date().toISOString()
    const questsBefore = await dailyQuestRepository.findForDate(job.user_id, job.target_date)
    const hadDailyPlan = questsBefore.length > 0
    let understandingDeltaActionCount = 0
    let playerBriefChangedCount = 0
    let noOpUnderstandingBatchCount = 0
    let latestPlayerBriefVersion = null
    let processedKnowledgeCount = 0
    let knowledgeBatchCount = 0
    let knowledgeBytes = 0
    let materialityCount = 0
    let materialityBatchEntryCount = 0
    let noChangeCount = 0
    let suggestedInterruptCount = 0
    let appliedInterruptCount = 0
    let lastBatchSignature = ''

    while (true) {
      const batch = await pendingKnowledgeBatch(client, job.user_id, cutoff)
      if (batch.ids.length === 0) break
      const signature = batch.ids.join(',')
      if (signature === lastBatchSignature) throw new Error('same knowledge batch repeated; backlog did not drain')
      lastBatchSignature = signature

      const delta = await derivePlayerUnderstandingDelta({
        provider,
        contextRetriever,
        repository: understandingRepository,
      }, {
        playerId: job.user_id,
        knowledgeEntryIds: batch.ids,
        date: job.target_date,
        batchKey: understandingDeltaBatchKey(batch.ids),
        limit: batch.ids.length,
      })

      understandingDeltaActionCount += delta.persistence.actionCount
      if (delta.persistence.playerBriefChanged) playerBriefChangedCount += 1
      if (delta.persistence.actionCount === 0) noOpUnderstandingBatchCount += 1
      latestPlayerBriefVersion = delta.persistence.playerBriefVersion
      processedKnowledgeCount += batch.ids.length
      knowledgeBatchCount += 1
      knowledgeBytes += batch.estimatedBytes

      const remaining = await pendingKnowledgeCount(client, job.user_id, cutoff)
      if (remaining === 0) break
      await sleep(AI_STAGE_PAUSE_MS)
    }

    const remainingKnowledge = await pendingKnowledgeCount(client, job.user_id, cutoff)
    if (remainingKnowledge > 0) throw new Error(`backlog did not drain; ${remainingKnowledge} knowledge entries remain in the activity window`)

    if (hadDailyPlan) {
      const materialityIds = await pendingMaterialityKnowledgeIds(client, job.user_id, cutoff)
      let activityAssessment = null

      if (materialityIds.length > 0) {
        if (knowledgeBatchCount > 0) await sleep(AI_STAGE_PAUSE_MS)
        const assessed = await assessActivityMateriality({ client, provider }, {
          playerId: job.user_id,
          knowledgeEntryIds: materialityIds,
          date: job.target_date,
          signalLimit: 32,
          rawKnowledgeBudgetBytes: MATERIALITY_RAW_BUDGET_BYTES,
        })
        activityAssessment = assessed.assessment
        materialityCount = assessed.source === 'assessed' ? 1 : 0
        materialityBatchEntryCount = materialityIds.length
        if (activityAssessment.disposition === 'no_change') noChangeCount = 1
      } else {
        activityAssessment = await unresolvedBatchAssessment(client, job.user_id, job.target_date, job.started_at)
      }

      if (activityAssessment && activityAssessment.disposition !== 'no_change') {
        await sleep(AI_STAGE_PAUSE_MS)
        const generated = await generateSystemInterrupt({
          provider,
          contextRetriever,
          repository: materialityRepository,
        }, {
          playerId: job.user_id,
          knowledgeEntryId: activityAssessment.knowledgeEntryId,
          date: job.target_date,
          assessment: activityAssessment,
        })
        if (generated.interrupt.status === 'applied') appliedInterruptCount = 1
        else suggestedInterruptCount = 1
      }
    }

    if (!hadDailyPlan && knowledgeBatchCount > 0) await sleep(AI_STAGE_PAUSE_MS)
    const generated = await generateDailyQuests({
      provider,
      contextRetriever,
      repository: dailyQuestRepository,
    }, {
      playerId: job.user_id,
      date: job.target_date,
    })

    if (!hadDailyPlan && generated.quests.length > 0) {
      await markBaselineKnowledgeNotRequired(client, job.user_id, cutoff)
    }

    const refs = provider.consumeConversationRefs()
    await completeJob(client, job, 'succeeded', refs, {
      derivedUnderstandingCount: understandingDeltaActionCount,
      understandingDeltaActionCount,
      playerBriefChangedCount,
      noOpUnderstandingBatchCount,
      latestPlayerBriefVersion,
      processedKnowledgeCount,
      knowledgeBatchCount,
      knowledgeBytes,
      knowledgeBatchBudgetBytes: KNOWLEDGE_BATCH_BUDGET_BYTES,
      materialityAssessmentCount: materialityCount,
      materialityBatchEntryCount,
      materialityNoChangeCount: noChangeCount,
      suggestedInterruptCount,
      appliedInterruptCount,
      questCount: generated.quests.length,
      questSource: generated.source,
      targetDate: job.target_date,
      windowCutoffAt: cutoff,
    })

    console.log(`[job ${job.id}] succeeded: ${processedKnowledgeCount} knowledge in ${knowledgeBatchCount} batches; deltaActions=${understandingDeltaActionCount}; brief=v${latestPlayerBriefVersion ?? 'unchanged'}; ${generated.quests.length} quests (${generated.source}); materiality=${materialityCount} over ${materialityBatchEntryCount} entries; interrupts=${appliedInterruptCount} applied/${suggestedInterruptCount} suggested`)
  } catch (rawError) {
    const error = classifyError(rawError)
    const refs = provider.consumeConversationRefs()

    if (error.code === 'browser_auth_required') {
      await completeJob(client, job, 'blocked_auth', refs, {}, error)
      console.error(`[job ${job.id}] blocked: ${error.message}`)
      return
    }

    const mayRetry = error.code === 'provider_rate_limited'
      || (error.retryable && Number(job.attempt_count || 0) < Number(job.max_attempts || 3))

    if (mayRetry) {
      const retryJob = await scheduleRetry(client, job, error, refs)
      if (retryJob?.status === 'paused_rate_limit') {
        console.error(`[job ${job.id}] provider circuit opened: ${error.message}`)
      } else {
        console.error(`[job ${job.id}] retry scheduled: ${error.code}: ${error.message}`)
      }
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
  console.log(browserRuntimeSummary())
  console.log(`Activity batching: knowledgeBudget=${KNOWLEDGE_BATCH_BUDGET_BYTES}B; materialityRawBudget=${MATERIALITY_RAW_BUDGET_BYTES}B; stagePause=${AI_STAGE_PAUSE_MS}ms; memory=${UNDERSTANDING_DELTA_VERSION}`)

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
