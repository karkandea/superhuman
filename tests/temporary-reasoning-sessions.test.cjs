/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('every fresh consumer reasoning room starts as Temporary Chat', () => {
  const transport = source('workers/chatgpt-consumer/browser-transport.mjs')
  assert.match(transport, /TEMPORARY_CHAT_URL = 'https:\/\/chatgpt\.com\/\?temporary-chat=true'/)
  assert.match(transport, /temporaryChat = true/)
  assert.match(transport, /conversationRef\s*\? conversationUrl\(conversationRef\)/)
  assert.match(transport, /\? TEMPORARY_CHAT_URL/)
})

test('provider marks prior room history as non-canonical working context', () => {
  const provider = source('lib/ai/chatgpt-consumer-provider.ts')
  assert.match(provider, /Conversation history in this temporary reasoning session is working context only/)
  assert.match(provider, /current CONTEXT_DATA wins/)
  assert.match(provider, /resolveConsumerConversation\(request\)/)
  assert.match(provider, /conversationRef: conversation\.conversationRef/)
  assert.match(provider, /temporaryChat: conversation\.temporaryChat/)
})

test('onboarding ASK keeps one worker-only room and READY closes it', () => {
  const sessions = source('lib/ai/reasoning-session.ts')
  const orchestrator = source('lib/ai/player-initialization-orchestrator.ts')
  const migration = source('supabase/sql/add_temporary_reasoning_sessions.sql')

  assert.match(sessions, /INITIALIZATION_PHASE_KEY = 'player_initialization'/)
  assert.match(sessions, /operation !== 'calibrate_player_initialization'/)
  assert.match(sessions, /\.eq\('status', 'active'\)/)
  assert.match(sessions, /input\.readiness === 'ready'/)
  assert.match(sessions, /status: 'closed'/)
  assert.match(sessions, /status: 'active'/)
  assert.match(orchestrator, /persistInitializationReasoningSession/)
  assert.match(orchestrator, /conversationRef: response\.conversationRef/)

  assert.match(migration, /create table if not exists public\.ai_reasoning_sessions/)
  assert.match(migration, /primary key\(user_id,phase_key\)/)
  assert.match(migration, /temporary_chat boolean not null default true/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /revoke all on public\.ai_reasoning_sessions from public, anon, authenticated/)
  assert.doesNotMatch(migration, /grant .*authenticated/)
})

test('ordinary tests cannot touch reasoning-session Supabase state', () => {
  const sessions = source('lib/ai/reasoning-session.ts')
  assert.match(sessions, /SUPERHUMAN_TEST_MODE === '1'/)
})

test('fake transport receives temporary-chat intent without any live browser call', async () => {
  const { ChatGptConsumerWebProvider } = require('../.domain-test-dist/lib/ai/chatgpt-consumer-provider.js')
  let captured = null
  const transport = {
    execute: async input => {
      captured = input
      return {
        text: JSON.stringify({
          requestId: 'temp-room-test',
          operation: 'derive_progression_map',
          schemaVersion: 'test.v1',
          payload: { ok: true },
        }),
        conversationRef: 'conversation-test-ref',
        modelLabel: 'fake-consumer-model',
      }
    },
  }

  const provider = new ChatGptConsumerWebProvider(transport, { idFactory: () => 'temp-room-test' })
  const response = await provider.invokeStructured({
    operation: 'derive_progression_map',
    schemaVersion: 'test.v1',
    instructions: 'test only',
    context: { playerId: 'player-test' },
    responseContract: { type: 'object' },
  })

  assert.equal(captured.temporaryChat, true)
  assert.equal(captured.conversationRef, undefined)
  assert.equal(response.conversationRef, 'conversation-test-ref')
})
