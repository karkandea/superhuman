const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('manual relay keeps the structured provider protocol and never launches browser transport', () => {
  const provider = read('lib/ai/manual-relay-provider.ts')
  const worker = read('workers/chatgpt-consumer/manual-worker.mjs')

  assert.match(provider, /readonly id = 'manual-relay'/)
  assert.match(provider, /buildConsumerChatPrompt/)
  assert.match(provider, /parseConsumerChatEnvelope/)
  assert.match(provider, /manual_inference_turns/)
  assert.match(provider, /requestHash/)
  assert.match(provider, /ManualInferencePendingError/)

  assert.match(worker, /ManualRelayProvider/)
  assert.match(worker, /pause_ai_inference_job_for_operator/)
  assert.doesNotMatch(worker, /PlaywrightChatGptTransport/)
  assert.doesNotMatch(worker, /browser-transport/)
})

test('manual relay migration has a durable operator wait-resume lifecycle', () => {
  const migration = read('supabase/sql/add_manual_relay_provider.sql')

  assert.match(migration, /create table if not exists public\.manual_inference_turns/)
  assert.match(migration, /'waiting_operator'/)
  assert.match(migration, /pause_ai_inference_job_for_operator/)
  assert.match(migration, /resume_ai_inference_job_from_operator/)
  assert.match(migration, /attempt_count = greatest\(attempt_count - 1, 0\)/)
  assert.match(migration, /revoke all on table public\.manual_inference_turns from public, anon, authenticated/)
})

test('operator UI requires an operator token and resumes only after a pasted response', () => {
  const route = read('app/api/operator/inference/route.ts')
  const page = read('app/operator/inference/page.tsx')

  assert.match(route, /SUPERHUMAN_OPERATOR_TOKEN/)
  assert.match(route, /x-superhuman-operator-token/)
  assert.match(route, /raw_response: rawResponse/)
  assert.match(route, /status: 'submitted'/)
  assert.match(route, /resume_ai_inference_job_from_operator/)

  assert.match(page, /COPY PROMPT/)
  assert.match(page, /PASTE CHATGPT RESPONSE/)
  assert.match(page, /SUBMIT & CONTINUE/)
  assert.match(page, /WEB SEARCH REQUIRED/)
})
