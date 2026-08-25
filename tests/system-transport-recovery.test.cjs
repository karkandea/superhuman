const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('System gives model and browser transport failures separate one-shot recovery budgets', () => {
  const sql = source('supabase/sql/extend_system_owned_transport_recovery.sql')

  assert.match(sql, /systemRecoveryCount/)
  assert.match(sql, /systemTransportRecoveryCount/)
  assert.match(sql, /pre_submission_state_invalid/)
  assert.match(sql, /composer_fill_timeout/)
  assert.match(sql, /generation_timeout/)
  assert.match(sql, /v_model_recovery_count < 1/)
  assert.match(sql, /v_transport_recovery_count < 1/)
  assert.match(sql, /j\.updated_at >= now\(\) - interval '24 hours'/)
  assert.match(sql, /not exists\([\s\S]*public\.quest_batches/)
})

test('transport recovery resets execution ownership but preserves durable step state', () => {
  const sql = source('supabase/sql/extend_system_owned_transport_recovery.sql')

  assert.match(sql, /status='queued'/)
  assert.match(sql, /correlation_id=gen_random_uuid\(\)/)
  assert.match(sql, /attempt_count=0/)
  assert.match(sql, /systemTransportRecoveryReason/)
  assert.doesNotMatch(sql, /delete\s+from\s+public\.progression_run_steps/i)
  assert.doesNotMatch(sql, /truncate\s+public\.progression_run_steps/i)
})

test('player status exposes whether System still has automatic recovery available', () => {
  const sql = source('supabase/sql/extend_system_owned_transport_recovery.sql')
  const client = source('lib/player-workflow-status.ts')

  assert.match(sql, /jsonb_build_object\('recoveryAvailable',v_recovery_available\)/)
  assert.match(sql, /'turnOwner','system'/)
  assert.doesNotMatch(sql, /request_progression_cycle/)
  assert.match(client, /recoveryAvailable:\s*boolean/)
  assert.match(client, /recoveryAvailable:\s*row\.recoveryAvailable === true/)
  assert.doesNotMatch(client, /row\.recoveryAvailable === true \? \{ recoveryAvailable: true \}/)
})
