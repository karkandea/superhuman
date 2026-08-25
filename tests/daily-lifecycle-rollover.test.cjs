/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('open Today tab detects midnight rollover without a manual reload', () => {
  const boundary = source('app/[username]/day-rollover-boundary.tsx')
  const layout = source('app/[username]/layout.tsx')

  assert.match(boundary, /window\.setInterval\(reconcileDay, 30_000\)/)
  assert.match(boundary, /hasLocalDayChanged\(dayRef\.current, nextDay\)/)
  assert.match(boundary, /setDayKey\(nextDay\)/)
  assert.match(boundary, /<Fragment key=\{dayKey\}>/)
  assert.match(layout, /<DayRolloverBoundary>\{routedContent\}<\/DayRolloverBoundary>/)
})

test('sleeping or backgrounded app reconciles the day immediately on resume', () => {
  const boundary = source('app/[username]/day-rollover-boundary.tsx')

  assert.match(boundary, /document\.visibilityState === 'visible'/)
  assert.match(boundary, /window\.addEventListener\('focus', reconcileDay\)/)
  assert.match(boundary, /window\.addEventListener\('pageshow', reconcileDay\)/)
  assert.match(boundary, /document\.addEventListener\('visibilitychange', handleVisibility\)/)
})

test('Today-state backend read self-heals lifecycle but never fabricates Daily Context', () => {
  const migration = source('supabase/sql/harden_daily_lifecycle_rollover.sql')

  assert.match(migration, /perform public\.ensure_player_progression_session\(p_target_date\)/)
  assert.match(migration, /if v_has_context and not v_has_quests and not found then/)
  assert.match(migration, /perform public\.request_progression_cycle\(p_target_date\)/)
  assert.doesNotMatch(migration, /insert into public\.daily_contexts/i)
})
