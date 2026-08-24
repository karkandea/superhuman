/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('inference attempt history preserves retry causes without exposing them to players', () => {
  const sql = source('supabase/sql/add_ai_inference_attempt_history.sql')
  assert.match(sql, /create table if not exists public\.ai_inference_attempts/)
  assert.match(sql, /status in \('running','retrying','succeeded','failed','blocked_auth','paused_rate_limit'\)/)
  assert.match(sql, /attempt_number smallint/)
  assert.match(sql, /latency_ms integer/)
  assert.match(sql, /error_code text/)
  assert.match(sql, /request_id text/)
  assert.match(sql, /revoke all on table public\.ai_inference_attempts from public, anon, authenticated/)
  assert.match(sql, /grant select, insert, update, delete on table public\.ai_inference_attempts to service_role/)
  assert.doesNotMatch(sql, /grant select on table public\.ai_inference_attempts to authenticated/)
})

test('claim opens one audit row and retry or completion closes the active row', () => {
  const sql = source('supabase/sql/add_ai_inference_attempt_history.sql')
  assert.match(sql, /insert into public\.ai_inference_attempts/)
  assert.match(sql, /v_job\.attempt_count,p_worker_id,'running'/)
  assert.match(sql, /v_attempt_status := 'retrying'/)
  assert.match(sql, /v_attempt_status := 'paused_rate_limit'/)
  assert.match(sql, /when p_status='blocked_auth' then 'blocked_auth'/)
  assert.match(sql, /where job_id=p_job_id and worker_id=p_worker_id and status='running'/)
  assert.match(sql, /extract\(epoch from \(now\(\)-started_at\)\)\*1000/)
  assert.match(sql, /safe_ai_failure_code/)
  assert.match(sql, /safe_ai_failure_message/)
})

test('provider rate-limit retries keep circuit-breaker semantics while becoming auditable', () => {
  const sql = source('supabase/sql/add_ai_inference_attempt_history.sql')
  assert.match(sql, /provider_rate_limit_count/)
  assert.match(sql, /v_rate_limit_count >= 3/)
  assert.match(sql, /status='paused_rate_limit'/)
  assert.match(sql, /case when v_rate_limit_count=1 then 900 else 1800 end/)
  assert.match(sql, /case when v_job\.error_code='provider_rate_limited' then attempt_count else attempt_count\+1 end/)
})
