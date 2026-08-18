/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('legacy understanding RPC preserves importance and refreshes Player Brief once per batch', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/bridge_legacy_understanding_to_player_brief.sql'), 'utf8')
  assert.match(sql, /create or replace function public\.persist_derived_understanding/i)
  assert.match(sql, /confidence,importance,/i)
  assert.match(sql, /\(v_candidate->>'importance'\)::smallint/i)
  assert.match(sql, /refresh_player_brief_internal\(p_user_id,'legacy_understanding_v1_bridge'\)/i)
  assert.match(sql, /legacy_player_brief_bridge',true/i)
  assert.match(sql, /grant execute[\s\S]*to service_role/i)
  assert.match(sql, /revoke all[\s\S]*from public, anon, authenticated/i)
})
