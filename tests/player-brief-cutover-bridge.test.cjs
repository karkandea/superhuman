/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('legacy understanding bridge protects mixed-version rollout then retires after cutover', () => {
  const bridgeSql = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/bridge_legacy_understanding_to_player_brief.sql'), 'utf8')
  const retireSql = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/retire_legacy_player_brief_bridge.sql'), 'utf8')

  assert.match(bridgeSql, /create or replace function public\.persist_derived_understanding/i)
  assert.match(bridgeSql, /confidence,importance,/i)
  assert.match(bridgeSql, /\(v_candidate->>'importance'\)::smallint/i)
  assert.match(bridgeSql, /refresh_player_brief_internal\(p_user_id,'legacy_understanding_v1_bridge'\)/i)
  assert.match(bridgeSql, /legacy_player_brief_bridge',true/i)
  assert.match(bridgeSql, /grant execute[\s\S]*to service_role/i)
  assert.match(bridgeSql, /revoke all[\s\S]*from public, anon, authenticated/i)

  assert.match(retireSql, /drop function if exists public\.persist_derived_understanding/i)
  assert.match(retireSql, /uuid,\s*jsonb,\s*uuid\[\],\s*uuid\[\],[\s\S]*timestamptz,\s*jsonb/i)
})
