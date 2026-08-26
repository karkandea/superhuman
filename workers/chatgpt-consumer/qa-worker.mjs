import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { ChatGptConsumerWebProvider } from '../../lib/ai/chatgpt-consumer-provider.ts'
import { PlaywrightChatGptTransport, browserRuntimeSummary } from './browser-transport.mjs'
import { getWorkerQaScenario, WORKER_QA_FIXTURE_VERSION } from './qa-scenarios.mjs'

const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url))
const WORKER_ID = process.env.SUPERHUMAN_QA_WORKER_ID || `superhuman-worker-qa:${process.pid}`
const POLL_MS = Number(process.env.SUPERHUMAN_QA_POLL_MS || 2500)
const LEASE_SECONDS = Number(process.env.SUPERHUMAN_QA_LEASE_SECONDS || 900)
const GENERATION_TIMEOUT_MS = Number(process.env.CHATGPT_GENERATION_TIMEOUT_MS || 180000)
const RELEASE_SHA = process.env.SUPERHUMAN_QA_RELEASE_SHA || currentReleaseSha()

let stopping = false

class QaValidationError extends Error {
  constructor(stepName, errors) {
    super(`Worker QA validator failed at ${stepName}: ${errors.join('; ')}`)
    this.name = 'QaValidationError'
    this.code = 'validator_failed'
    this.validatorErrors = errors
  }
}

function currentReleaseSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown-release'
  }
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function serviceKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

function createSupabase() {
  const key = serviceKey()
  if (!key) throw new Error('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(requiredEnv('SUPABASE_URL'), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeRpcRow(data) {
  if (Array.isArray(data)) return data[0] || null
  return data && typeof data === 'object' ? data : null
}

function jsonSafe(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { serializationError: true, preview: String(value).slice(0, 500) }
  }
}

function boundedMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500)
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code.trim() : ''
  if (code) return code.slice(0, 120)
  if (/output repair exhausted/i.test(boundedMessage(error))) return 'model_output_invalid'
  return 'qa_execution_failed'
}

function parseCheckpointLine(line) {
  if (!line.includes('[worker-checkpoint]')) return null
  const requestId = line.match(/\brequestId=([^\s]+)/)?.[1] || null
  const stage = line.match(/\bstage=([^\s]+)/)?.[1]
  const status = line.match(/\bstatus=([^\s]+)/)?.[1]
  if (!stage || !status) return null
  const detailStart = line.indexOf(`status=${status}`) + `status=${status}`.length
  const detail = line.slice(detailStart).trim()
  return {
    at: new Date().toISOString(),
    requestId,
    stage,
    status,
    detail: detail || null,
  }
}

async function captureCheckpoints(task) {
  const checkpoints = []
  const downstreamWrite = process.stdout.write

  process.stdout.write = function qaObservedStdout(chunk, encoding, callback) {
    for (const line of String(chunk).split('\n')) {
      const parsed = parseCheckpointLine(line)
      if (parsed) checkpoints.push(parsed)
    }
    return downstreamWrite.call(process.stdout, chunk, encoding, callback)
  }

  try {
    const value = await task()
    return { value, checkpoints }
  } catch (error) {
    error.qaCheckpoints = checkpoints
    throw error
  } finally {
    process.stdout.write = downstreamWrite
  }
}

function recoveryCount(checkpoints) {
  return checkpoints.filter(event => event.stage === 'recovery' && event.status === 'start').length
}

async function claimIteration(client) {
  const { data, error } = await client.rpc('claim_worker_qa_iteration', {
    p_worker_id: WORKER_ID,
    p_release_sha: RELEASE_SHA,
    p_lease_seconds: LEASE_SECONDS,
  })
  if (error) throw new Error(`claim Worker QA iteration: ${error.message}`)
  return normalizeRpcRow(data)
}

async function insertStep(client, claim, workerAttempt, stepOrder, spec) {
  const { data, error } = await client
    .from('worker_qa_steps')
    .insert({
      run_id: claim.run_id,
      iteration_id: claim.iteration_id,
      worker_attempt: workerAttempt,
      step_order: stepOrder,
      step_name: spec.name,
      operation: spec.request.operation,
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) throw new Error(`start Worker QA step: ${error.message}`)
  return data.id
}

async function finishStep(client, stepId, details) {
  const { error } = await client
    .from('worker_qa_steps')
    .update({
      status: details.status,
      duration_ms: details.durationMs,
      validator_passed: details.validatorPassed,
      recovery_count: details.recoveryCount,
      request_id: details.requestId || null,
      error_code: details.errorCode || null,
      error_message: details.errorMessage || null,
      output: jsonSafe(details.output),
      validator_errors: jsonSafe(details.validatorErrors || []),
      checkpoints: jsonSafe(details.checkpoints || []),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', stepId)
  if (error) throw new Error(`finish Worker QA step: ${error.message}`)
}

async function completeIteration(client, claim, details) {
  const { error } = await client.rpc('complete_worker_qa_iteration', {
    p_iteration_id: claim.iteration_id,
    p_worker_id: WORKER_ID,
    p_status: details.status,
    p_duration_ms: details.durationMs,
    p_validator_passed: details.validatorPassed,
    p_recovery_count: details.recoveryCount,
    p_error_code: details.errorCode || null,
    p_error_message: details.errorMessage || null,
    p_output: jsonSafe(details.output),
    p_checkpoints: jsonSafe(details.checkpoints || []),
  })
  if (error) throw new Error(`complete Worker QA iteration: ${error.message}`)
}

async function processIteration(client, claim) {
  const startedAt = Date.now()
  const allCheckpoints = []
  const outputs = {}
  let totalRecoveryCount = 0
  let allValidatorsPassed = true
  let stepOrder = 0
  const workerAttempt = Number(claim.worker_attempt || 1)

  if (claim.fixture_version !== WORKER_QA_FIXTURE_VERSION) {
    await completeIteration(client, claim, {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      validatorPassed: false,
      recoveryCount: 0,
      errorCode: 'fixture_version_mismatch',
      errorMessage: `Run fixture=${claim.fixture_version}; worker fixture=${WORKER_QA_FIXTURE_VERSION}`,
      output: null,
      checkpoints: [],
    })
    return
  }

  const scenario = getWorkerQaScenario(claim.scenario)
  const transport = new PlaywrightChatGptTransport()
  const provider = new ChatGptConsumerWebProvider(transport, {
    timeoutMs: GENERATION_TIMEOUT_MS,
    reasoningLevel: 'high',
    idFactory: () => `qa:${claim.run_id}:${claim.iteration_no}:${randomUUID()}`,
  })

  const runStep = async spec => {
    stepOrder += 1
    const stepId = await insertStep(client, claim, workerAttempt, stepOrder, spec)
    const stepStartedAt = Date.now()
    let checkpoints = []
    let response = null
    let telemetryCommitted = false

    try {
      const captured = await captureCheckpoints(() => provider.invokeStructured(spec.request))
      response = captured.value
      checkpoints = captured.checkpoints
      const validatorErrors = spec.validator(response.output)
      const stepRecoveryCount = recoveryCount(checkpoints)

      allCheckpoints.push(...checkpoints.map(event => ({ ...event, qaStep: spec.name, qaStepOrder: stepOrder })))
      totalRecoveryCount += stepRecoveryCount
      telemetryCommitted = true
      outputs[spec.name] = jsonSafe(response.output)

      await finishStep(client, stepId, {
        status: validatorErrors.length ? 'failed' : 'succeeded',
        durationMs: Date.now() - stepStartedAt,
        validatorPassed: validatorErrors.length === 0,
        recoveryCount: stepRecoveryCount,
        requestId: response.requestId,
        output: response.output,
        validatorErrors,
        checkpoints,
        errorCode: validatorErrors.length ? 'validator_failed' : null,
        errorMessage: validatorErrors.length ? validatorErrors.join('; ').slice(0, 500) : null,
      })

      if (validatorErrors.length) {
        allValidatorsPassed = false
        throw new QaValidationError(spec.name, validatorErrors)
      }
      return response.output
    } catch (error) {
      checkpoints = Array.isArray(error.qaCheckpoints) ? error.qaCheckpoints : checkpoints
      const stepRecoveryCount = recoveryCount(checkpoints)
      if (!telemetryCommitted && checkpoints.length) {
        allCheckpoints.push(...checkpoints.map(event => ({ ...event, qaStep: spec.name, qaStepOrder: stepOrder })))
        totalRecoveryCount += stepRecoveryCount
      }

      if (!(error instanceof QaValidationError)) {
        await finishStep(client, stepId, {
          status: 'failed',
          durationMs: Date.now() - stepStartedAt,
          validatorPassed: false,
          recoveryCount: stepRecoveryCount,
          requestId: response?.requestId,
          output: response?.output,
          validatorErrors: [],
          checkpoints,
          errorCode: errorCode(error),
          errorMessage: boundedMessage(error),
        })
      }
      throw error
    }
  }

  try {
    await scenario.run(runStep)
    await completeIteration(client, claim, {
      status: 'succeeded',
      durationMs: Date.now() - startedAt,
      validatorPassed: allValidatorsPassed,
      recoveryCount: totalRecoveryCount,
      output: outputs,
      checkpoints: allCheckpoints,
    })
    console.log(`[qa ${claim.run_id} #${claim.iteration_no}] succeeded scenario=${claim.scenario} recovery=${totalRecoveryCount}`)
  } catch (error) {
    await completeIteration(client, claim, {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      validatorPassed: false,
      recoveryCount: totalRecoveryCount,
      errorCode: errorCode(error),
      errorMessage: boundedMessage(error),
      output: outputs,
      checkpoints: allCheckpoints,
    })
    console.error(`[qa ${claim.run_id} #${claim.iteration_no}] failed: ${errorCode(error)}: ${boundedMessage(error)}`)
  }
}

async function main() {
  const client = createSupabase()
  console.log(`Superhuman Worker QA online as ${WORKER_ID}`)
  console.log(`QA fixture=${WORKER_QA_FIXTURE_VERSION}; release=${RELEASE_SHA}`)
  console.log(browserRuntimeSummary())

  while (!stopping) {
    const claim = await claimIteration(client)
    if (!claim) {
      await sleep(POLL_MS)
      continue
    }
    await processIteration(client, claim)
  }
}

process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })

main().catch(error => {
  console.error(`[qa-worker] fatal: ${boundedMessage(error)}`)
  process.exitCode = 1
})
