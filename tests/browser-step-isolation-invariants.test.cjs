/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

const transport = source('workers/chatgpt-consumer/browser-transport.mjs')
const recoverySql = source('supabase/sql/classify_browser_invariant_recovery.sql')
const worker = source('workers/chatgpt-consumer/worker-v2.mjs')
const reasoningSession = source('lib/ai/reasoning-session.ts')


test('every consumer AI invocation owns a fresh page and disposes it before the next step', () => {
  assert.match(transport, /let page = await context\.newPage\(\)/)
  assert.match(transport, /stage=\$\{stage\}/)
  assert.match(transport, /checkpoint\(correlationId, 'step_isolation', 'start', 'page=fresh'\)/)
  assert.match(transport, /checkpoint\(correlationId, 'step_isolation', 'disposed', 'page=closed'\)/)
  assert.match(transport, /finally \{[\s\S]*await page\?\.close\(\)/)
})


test('only onboarding calibration may reuse a conversation; normal progression steps start fresh', () => {
  assert.match(reasoningSession, /if \(request\.operation !== 'calibrate_player_initialization'\) return base/)
  assert.match(reasoningSession, /const base: ConsumerConversationHint = \{ temporaryChat: true \}/)
})


test('pre-submission failures expose the failed invariant instead of collapsing to one generic code', () => {
  for (const code of [
    'page_not_ready',
    'temporary_chat_not_active',
    'composer_not_editable',
    'tool_state_invalid',
    'composer_fill_failed',
  ]) {
    assert.match(transport, new RegExp(`['\"]${code}['\"]`), `missing granular invariant ${code}`)
  }
  assert.doesNotMatch(transport, /new WorkerError\('pre_submission_state_invalid'/)
})


test('composer fill participates in the bounded local recovery loop', () => {
  const loopStart = transport.indexOf('for (let attempt = 1; attempt <= Math.max(1, PRE_SUBMISSION_RECOVERY_ATTEMPTS); attempt += 1)')
  const fillIndex = transport.indexOf('await fillComposerVerified(composer, prompt, deadline)', loopStart)
  const loopBreak = transport.indexOf('prepared = true', loopStart)
  const recoveryIndex = transport.indexOf('recoverPreSubmissionPage(context, page, correlationId, attempt, error)', loopStart)
  assert.ok(loopStart >= 0)
  assert.ok(fillIndex > loopStart && fillIndex < loopBreak, 'composer fill must happen before successful pre-submit break')
  assert.ok(recoveryIndex > loopBreak, 'failed fill must route through local invariant recovery')
  assert.match(transport, /CHATGPT_PRE_SUBMISSION_RECOVERY_ATTEMPTS \|\| 2/)
})


test('recovery is selected by failed invariant while every retry re-runs preparation from known state', () => {
  assert.match(transport, /errorCode === 'composer_not_editable'\) return 'reload_composer'/)
  assert.match(transport, /errorCode === 'tool_state_invalid'\) return 'reset_tool_state'/)
  assert.match(transport, /errorCode === 'temporary_chat_not_active'\) return 'reset_temporary_chat'/)
  assert.match(transport, /errorCode === 'page_not_ready'\) return 'reload_page'/)
  assert.match(transport, /errorCode === 'composer_fill_failed'\) return 'fresh_page'/)
  assert.match(transport, /strategy=\$\{strategy\}/)
  assert.match(transport, /composer = await preparePageForRequest\(page, \{ conversationRef, temporaryChat, webSearch, deadline \}\)/)
})


test('granular invariant codes remain inside the same one-shot System transport recovery budget', () => {
  assert.match(recoverySql, /create or replace function public\.is_system_transport_recovery_code/)
  for (const code of [
    'page_not_ready',
    'temporary_chat_not_active',
    'composer_not_editable',
    'tool_state_invalid',
    'composer_fill_failed',
  ]) {
    assert.match(recoverySql, new RegExp(`['\"]${code}['\"]`))
  }
  assert.match(recoverySql, /systemTransportRecoveryCount/)
  assert.match(recoverySql, /< 1/)
  assert.match(recoverySql, /'pre_submission_state_invalid'/, 'legacy failed jobs must remain recoverable')
})


test('durable progression checkpoints remain the worker boundary and are not reset by browser recovery', () => {
  assert.match(worker, /runStepStore\.start/)
  assert.match(worker, /runStepStore\.complete/)
  assert.doesNotMatch(transport, /progression_run_steps/)
  assert.doesNotMatch(recoverySql, /delete from public\.progression_run_steps/i)
  assert.doesNotMatch(recoverySql, /truncate[^;]*progression_run_steps/i)
})
