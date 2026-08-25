const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('player generation uses an idempotent one-shot start RPC instead of the mutating progression primitive', () => {
  const service = source('lib/ai/inference-job-service.ts')
  const sql = source('supabase/sql/fix_system_owned_workflow_recovery.sql')

  assert.match(service, /client\.rpc\('start_progression_cycle_after_checkin'/)
  assert.doesNotMatch(service, /client\.rpc\('request_progression_cycle'/)
  assert.match(sql, /create or replace function public\.start_progression_cycle_after_checkin/)
  assert.match(sql, /on conflict \(user_id, operation, target_date\) do nothing/)
  assert.match(sql, /revoke all on function public\.request_progression_cycle\(date\) from public, anon, authenticated/)
})

test('player workflow status is read-only and normalizes failed or stalled unowned work to System ownership', () => {
  const sql = source('supabase/sql/fix_system_owned_workflow_recovery.sql')
  const start = sql.indexOf('create or replace function public.get_player_workflow_status_v2')
  const end = sql.indexOf("revoke all on function public.get_player_workflow_status_v2(date)", start)
  const statusBody = sql.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(statusBody, /v_status := public\.get_player_workflow_status\(p_target_date\)/)
  assert.match(statusBody, /v_status->>'turnOwner',''\)='none'/)
  assert.match(statusBody, /v_status->>'activity',''\) in \('failed','stalled'\)/)
  assert.match(statusBody, /'turnOwner','system'/)
  assert.doesNotMatch(statusBody, /request_progression_cycle/)
  assert.doesNotMatch(statusBody, /ensure_player_progression_session/)
})

test('worker claim performs only one bounded automatic recovery for internal model failures', () => {
  const sql = source('supabase/sql/fix_system_owned_workflow_recovery.sql')

  assert.match(sql, /j\.error_code in \('model_output_invalid','inference_failed'\)/)
  assert.match(sql, /systemRecoveryCount/)
  assert.match(sql, /end < 1/)
  assert.match(sql, /j\.updated_at >= now\(\) - interval '24 hours'/)
  assert.match(sql, /not exists\([\s\S]*public\.quest_batches/)
  assert.match(sql, /status='queued'/)
})

test('Today UX makes System ownership explicit and status refresh cannot be mistaken for an AI trigger', () => {
  const page = source('app/[username]/page.tsx')

  assert.match(page, /\['queued', 'running', 'stalled', 'failed'\]\.includes\(workflow\.activity\)/)
  assert.match(page, /System lagi memulihkan proses/)
  assert.match(page, /Bola ada di System\. Lo nggak perlu ngapa-ngapain\./)
  assert.match(page, /MUAT ULANG STATUS/)
  assert.match(page, /nggak memulai atau mengulang proses AI/)
  assert.doesNotMatch(page, /NGGAK ADA ACTION DARI LO/)
})
