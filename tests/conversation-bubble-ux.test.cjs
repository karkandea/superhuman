/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('conversation visual language is shared instead of reimplemented as unrelated cards', () => {
  const bubble = source('app/[username]/conversation-bubble.tsx')
  const home = source('app/[username]/today-conversation-shell.tsx')
  const history = source('app/[username]/history/sessions/[sessionId]/page.tsx')

  assert.match(bubble, /data-conversation-bubble=\{actor\}/)
  assert.match(bubble, /actor: 'system' \| 'player'/)
  assert.match(home, /import ConversationBubble/)
  assert.match(home, /data-conversation-thread="progression"/)
  assert.match(history, /import ConversationBubble/)
  assert.match(history, /data-conversation-thread="episode-history"/)
})

test('onboarding keeps cinematic system moments but questions run as one conversation thread', () => {
  const onboarding = source('app/[username]/player-initialization.tsx')

  assert.match(onboarding, /<SystemMoment>/)
  assert.match(onboarding, /data-conversation-thread="onboarding"/)
  assert.match(onboarding, /conversationHistory/)
  assert.match(onboarding, /status === 'answered' \|\| item\.status === 'skipped'/)
  assert.match(onboarding, /<ConversationBubble actor="system"/)
  assert.match(onboarding, /<ConversationBubble actor="player"/)
  assert.match(onboarding, /data-player-answer-composer/)
  assert.match(onboarding, /placeholder="Balas System…"/)
  assert.match(onboarding, /← KEMBALI/)
})

test('material clarification on Home is presented as a system bubble plus player reply composer', () => {
  const home = source('app/[username]/today-conversation-shell.tsx')

  assert.match(home, /function QuestionComposer/)
  assert.match(home, /data-conversation-question/)
  assert.match(home, /<ConversationBubble actor="system"/)
  assert.match(home, /alignSelf: 'flex-end'/)
  assert.match(home, /KIRIM →/)
  assert.doesNotMatch(home, /SYSTEM NANYA/)
})
