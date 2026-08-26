/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

const migration = source('supabase/sql/add_worker_qa_harness.sql')
const worker = source('workers/chatgpt-consumer/qa-worker.mjs')
const scenarios = source('workers/chatgpt-consumer/qa-scenarios.mjs')
const unit = source('ops/worker-qa/superhuman-ai-qa-worker.service')
const installer = source('ops/worker-qa/install.sh')

test('Worker QA uses a queue namespace isolated from production inference jobs', () => {
  for (const table of ['worker_qa_runs', 'worker_qa_iterations', 'worker_qa_steps']) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`))
  }
  assert.match(migration, /request_worker_qa_run/)
  assert.match(migration, /claim_worker_qa_iteration/)
  assert.match(migration, /complete_worker_qa_iteration/)
  assert.match(migration, /get_worker_qa_run/)
  assert.doesNotMatch(migration, /insert into public\.ai_inference_jobs/i)
  assert.doesNotMatch(worker, /claim_ai_inference_job/)
})

test('QA control plane is service-role only and player roles cannot operate the harness', () => {
  assert.match(migration, /revoke all on table public\.worker_qa_runs from public, anon, authenticated/)
  assert.match(migration, /revoke all on function public\.request_worker_qa_run\(text, integer\) from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.request_worker_qa_run\(text, integer\) to service_role/)
  assert.match(migration, /grant execute on function public\.cancel_worker_qa_run\(uuid\) to service_role/)
  assert.match(migration, /grant execute on function public\.get_worker_qa_run\(uuid\) to service_role/)
})

test('QA runner uses the real consumer provider and Playwright browser transport', () => {
  assert.match(worker, /ChatGptConsumerWebProvider/)
  assert.match(worker, /PlaywrightChatGptTransport/)
  assert.match(worker, /reasoningLevel: 'high'/)
  assert.match(worker, /captureCheckpoints/)
  assert.match(worker, /recoveryCount/)
  assert.match(worker, /worker_qa_steps/)
})

test('QA runs are versioned by fixture and worker release SHA for comparable reruns', () => {
  assert.match(scenarios, /WORKER_QA_FIXTURE_VERSION = 'worker-qa\.v1'/)
  assert.match(worker, /git', \['rev-parse', 'HEAD'\]/)
  assert.match(worker, /fixture_version_mismatch/)
  assert.match(migration, /release_sha text/)
  assert.match(migration, /fixture_version text not null default 'worker-qa\.v1'/)
})

test('QA offers bounded step and full-chain scenarios with real Search mode', () => {
  for (const scenario of [
    'progression_target_normal',
    'quest_generation_normal',
    'search',
    'composer_recovery',
    'full_chain_normal',
  ]) {
    assert.match(scenarios, new RegExp(`['\"]${scenario}['\"]`))
    assert.match(migration, new RegExp(`['\"]${scenario}['\"]`))
  }
  assert.match(scenarios, /operation: 'research_progression_context'/)
  assert.match(scenarios, /operation: 'choose_progression_target'/)
  assert.match(scenarios, /operation: 'generate_daily_quests'/)
})

test('QA service uses a dedicated browser profile and CDP port', () => {
  assert.match(unit, /CHATGPT_BROWSER_PROFILE_DIR=\/var\/lib\/superhuman-ai\/chatgpt-qa-profile/)
  assert.match(unit, /CHATGPT_CDP_PORT=9223/)
  assert.match(unit, /CHATGPT_CDP_URL=http:\/\/127\.0\.0\.1:9223/)
  assert.doesNotMatch(unit, /CHATGPT_BROWSER_PROFILE_DIR=\/var\/lib\/superhuman-ai\/chatgpt-profile\s*$/m)
  assert.match(installer, /QA_PROFILE=\/var\/lib\/superhuman-ai\/chatgpt-qa-profile/)
  assert.match(installer, /PROD_PROFILE=\/var\/lib\/superhuman-ai\/chatgpt-profile/)
})

test('QA claim yields to runnable production work and runs stay bounded', () => {
  assert.match(migration, /Production work wins resource priority/)
  assert.match(migration, /from public\.ai_inference_jobs j/)
  assert.match(migration, /p_repetitions > 50/)
  assert.match(migration, /p_lease_seconds > 1800/)
})

test('QA worker modules parse as JavaScript without launching live AI', () => {
  for (const file of [
    'workers/chatgpt-consumer/qa-worker.mjs',
    'workers/chatgpt-consumer/qa-scenarios.mjs',
  ]) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
})
