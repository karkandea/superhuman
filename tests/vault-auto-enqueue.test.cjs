/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('ordinary Vault evidence auto-enqueues progression without bypassing onboarding or provider cooldowns', () => {
  const sql = source('supabase/sql/restore_vault_progression_enqueue.sql')

  assert.match(sql, /create or replace function public\.enqueue_progression_on_knowledge_insert\(\)/)
  assert.match(sql, /create trigger knowledge_entries_enqueue_progression/)
  assert.match(sql, /after insert on public\.knowledge_entries/)
  assert.match(sql, /content_metadata->>'system',''\) = 'player_initialization'/)
  assert.match(sql, /coalesce\(v_readiness,'ask'\) <> 'ready'/)
  assert.match(sql, /interval '2 minutes'/)
  assert.match(sql, /interval '10 minutes'/)
  assert.match(sql, /v_job\.status = 'running'/)
  assert.match(sql, /v_job\.status = 'paused_rate_limit'/)
  assert.match(sql, /v_job\.error_code='provider_rate_limited'/)
  assert.match(sql, /set rerun_requested=true/)
  assert.match(sql, /available_at=least\(now\(\)\+v_debounce,v_window_start\+v_max_wait\)/)
  assert.match(sql, /revoke all on function public\.enqueue_progression_on_knowledge_insert\(\) from public, anon, authenticated, service_role/)
})
