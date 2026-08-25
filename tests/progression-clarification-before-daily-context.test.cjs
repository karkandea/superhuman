/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/sql/allow_progression_answer_processing_before_daily_context.sql'),
  'utf8',
)

test('pending clarification evidence can be processed before Daily Context while first quest remains gated', () => {
  const pendingIndex = migration.indexOf('v_has_pending_progression :=')
  const gateIndex = migration.indexOf("Daily Context check-in required before first Daily Quest generation")

  assert.ok(pendingIndex >= 0)
  assert.ok(gateIndex > pendingIndex)
  assert.match(migration, /not v_has_quests and not v_has_daily_context and not v_has_pending_progression/)
  assert.match(migration, /processing_status in \('pending','failed'\)/)
})
