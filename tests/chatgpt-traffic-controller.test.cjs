/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

const migration = source('supabase/sql/add_chatgpt_traffic_controller.sql')
const claimGuard = source('supabase/sql/guard_worker_qa_claim_with_traffic_state.sql')
const controller = source('lib/ai/chatgpt-traffic-controller.ts')
const provider = source('lib/ai/chatgpt-consumer-provider.ts')
const qaUnit = source('ops/worker-qa/superhuman-ai-qa-worker.service')

test('production and QA share one service-role-only ChatGPT traffic state', () => {
  assert.match(migration, /create table if not exists public\.chatgpt_traffic_state/)
  assert.match(migration, /active_holder text/)
  assert.match(migration, /active_kind text/)
  assert.match(migration, /lease_expires_at timestamptz/)
  assert.match(migration, /cooldown_until timestamptz/)
  assert.match(migration, /qa_cooldown_until timestamptz/)
  assert.match(migration, /last_success_at timestamptz/)
  assert.match(migration, /last_rate_limit_at timestamptz/)
  assert.match(migration, /rate_limit_streak integer/)
  assert.match(migration, /revoke all on table public\.chatgpt_traffic_state from public, anon, authenticated/)
  assert.match(migration, /grant select on table public\.chatgpt_traffic_state to service_role/)
})

test('shared controller enforces concurrency one and production priority', () => {
  assert.match(migration, /acquire_chatgpt_traffic_slot/)
  assert.match(migration, /for update/)
  assert.match(migration, /v_state\.active_holder is not null/)
  assert.match(migration, /return query select false, 'busy'/)
  assert.match(migration, /p_client_kind='qa'/)
  assert.match(migration, /from public\.ai_inference_jobs j/)
  assert.match(migration, /return query select false, 'production_priority'/)
  assert.match(claimGuard, /from public\.chatgpt_traffic_state/)
  assert.match(claimGuard, /qa_cooldown_until/)
  assert.match(claimGuard, /qa_next_allowed_at/)
})

test('provider rate-limit opens adaptive global and longer QA circuit breakers', () => {
  assert.match(migration, /record_chatgpt_traffic_result/)
  assert.match(migration, /when v_next_streak=1 then 180/)
  assert.match(migration, /when v_next_streak=2 then 300/)
  assert.match(migration, /else 600/)
  assert.match(migration, /when v_next_streak=1 then 900/)
  assert.match(migration, /when v_next_streak=2 then 1800/)
  assert.match(migration, /else 3600/)
  assert.match(migration, /qa_next_allowed_at=case/)
  assert.match(migration, /2 \^ least\(v_state\.rate_limit_streak,2\)/)
})

test('every real consumer transport call is wrapped by shared traffic acquisition and result recording', () => {
  assert.match(provider, /acquireChatGptTrafficSlot/)
  assert.match(provider, /recordChatGptTrafficResult/)
  assert.match(provider, /private async executeTransport/)
  assert.match(provider, /let execution = await this\.executeTransport/)
  assert.match(provider, /const repairExecution = await this\.executeTransport/)
  assert.match(provider, /this\.transport\.execute\(input\)/)
  assert.match(provider, /recordChatGptTrafficResult\(holderId, 'success'\)/)
  assert.match(provider, /recordChatGptTrafficResult\(holderId, 'rate_limited'\)/)
})

test('ordinary mock tests bypass the live traffic controller', () => {
  assert.match(controller, /SUPERHUMAN_TEST_MODE === '1'/)
  assert.match(controller, /if \(TEST_MODE\) return \{ holderId: `test:\$\{correlationId\}` \}/)
  assert.match(controller, /if \(TEST_MODE\) return null/)
})

test('live Worker Lab is capped to canary size instead of load testing ChatGPT', () => {
  assert.match(migration, /Live Worker Lab runs are canaries, not load tests/)
  assert.match(migration, /p_repetitions > 2/)
  assert.match(migration, /mock\/replay coverage for larger batches/)
})

test('QA runtime identifies itself to the shared controller and shuts down gracefully', () => {
  assert.match(qaUnit, /SUPERHUMAN_CHATGPT_TRAFFIC_KIND=qa/)
  assert.match(qaUnit, /SUPERHUMAN_QA_BASE_INTERVAL_SECONDS=60/)
  assert.match(qaUnit, /SUPERHUMAN_QA_INTER_ITERATION_PAUSE_MS=1000/)
  assert.match(qaUnit, /TimeoutStopSec=210/)
  assert.doesNotMatch(qaUnit, /SUPERHUMAN_CHATGPT_TRAFFIC_KIND=production/)
})
