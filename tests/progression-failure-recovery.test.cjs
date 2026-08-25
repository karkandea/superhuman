/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const sql = fs.readFileSync('supabase/sql/harden_progression_failure_recovery.sql', 'utf8')
const workflow = fs.readFileSync('lib/player-workflow-status.ts', 'utf8')

test('recoverable transport failures reopen the normal progression request path', () => {
  assert.match(sql, /get_player_workflow_status_v2/)
  assert.match(sql, /'generation_finish_timeout'/)
  assert.match(sql, /'transient_transport_error'/)
  assert.match(sql, /'canStart', true/)
  assert.match(sql, /'recoveryAvailable', true/)
  assert.doesNotMatch(sql, /'browser_auth_required'[\s\S]*v_recoverable_codes/)
  assert.doesNotMatch(sql, /'provider_rate_limited'[\s\S]*v_recoverable_codes/)
  assert.doesNotMatch(sql, /'insufficient_context'[\s\S]*v_recoverable_codes/)
})

test('player workflow client consumes the hardened recovery status', () => {
  assert.match(workflow, /get_player_workflow_status_v2/)
  assert.match(workflow, /recoveryAvailable: boolean/)
  assert.match(workflow, /recoveryAvailable: row\.recoveryAvailable === true/)
  assert.doesNotMatch(workflow, /recoveryAvailable\?: boolean/)
})

test('terminal job state stops stale deciding sessions and requeue resets them', () => {
  assert.match(sql, /sync_progression_session_with_job_lifecycle/)
  assert.match(sql, /set state='stopped'/)
  assert.match(sql, /new\.status='queued'/)
  assert.match(sql, /set state='understanding'/)
})
