/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const sql = fs.readFileSync(path.join(root, 'supabase/sql/harden_activity_window_batching.sql'), 'utf8')
const worker = fs.readFileSync(path.join(root, 'workers/chatgpt-consumer/worker-v2.mjs'), 'utf8')

test('activity queue uses two-minute debounce with ten-minute hard max wait', () => {
  assert.match(sql, /interval '2 minutes'/)
  assert.match(sql, /interval '10 minutes'/)
  assert.match(sql, /least\(now\(\)\+v_debounce,v_window_start\+v_max_wait\)/)
})

test('provider throttling opens an explicit circuit breaker', () => {
  assert.match(sql, /paused_rate_limit/)
  assert.match(sql, /v_rate_limit_count >= 3/)
  assert.match(sql, /when v_rate_limit_count=1 then 900 else 1800/)
})

test('worker snapshots a cutoff, drains byte-budget batches, and performs one activity materiality call', () => {
  assert.match(worker, /window_cutoff_at/)
  assert.match(worker, /KNOWLEDGE_BATCH_BUDGET_BYTES/)
  assert.match(worker, /while \(true\)/)
  const calls = worker.match(/assessActivityMateriality\(/g) || []
  assert.equal(calls.length, 1)
})

test('new worker modules parse as JavaScript', () => {
  execFileSync(process.execPath, ['--check', path.join(root, 'workers/chatgpt-consumer/browser-transport.mjs')])
  execFileSync(process.execPath, ['--check', path.join(root, 'workers/chatgpt-consumer/worker-v2.mjs')])
})
