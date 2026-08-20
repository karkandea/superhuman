/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('READY defers strategic AI until the explicit Daily Context progression decision', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/defer_strategic_activation_until_daily_decision.sql'), 'utf8')
  const wrapper = fs.readFileSync(path.join(process.cwd(), 'lib/ai/player-initialization-progression.ts'), 'utf8')

  assert.match(sql, /strategic_activation_pending boolean not null default false/i)
  assert.match(sql, /strategic_activation_pending=case when p_readiness='ready' then true else false end/i)
  assert.match(sql, /Player Initialization is not READY; Daily Context is blocked/i)
  assert.match(sql, /set strategic_activation_pending=false/i)
  assert.match(sql, /Daily Context check-in required before first Daily Quest generation/i)
  assert.match(wrapper, /shouldDeferProgressionMapForInitialization/)
  assert.match(wrapper, /player_initialization_strategic_activation_deferred/)
})
