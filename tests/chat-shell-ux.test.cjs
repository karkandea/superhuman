/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('long plain-text chat bubbles are collapsed by default and explicitly expandable', () => {
  const bubble = source('app/[username]/conversation-bubble.tsx')

  assert.match(bubble, /collapseThreshold = 360/)
  assert.match(bubble, /plainText\.length > collapseThreshold/)
  assert.match(bubble, /data-collapsible=\{canCollapse \? 'true' : 'false'\}/)
  assert.match(bubble, /Lihat selengkapnya ↓/)
  assert.match(bubble, /Ringkas ↑/)
  assert.match(bubble, /aria-expanded=\{expanded\}/)
})

test('active chat surfaces identify Superhuman and the player with a sticky participant header', () => {
  const header = source('app/[username]/conversation-header.tsx')
  const onboarding = source('app/[username]/player-initialization.tsx')
  const home = source('app/[username]/today-conversation-shell.tsx')

  assert.match(header, /data-conversation-header/)
  assert.match(header, /position: 'sticky'/)
  assert.match(header, />\s*Superhuman\s*</)
  assert.match(header, /data-player-identity/)
  assert.match(header, /AI PROGRESSION AGENT/)
  assert.match(onboarding, /<ConversationHeader/)
  assert.match(onboarding, /playerName=\{playerName\}/)
  assert.match(home, /<ConversationHeader/)
  assert.match(home, /playerName=\{username\}/)
})

test('onboarding keeps the thread scrollable while the active reply composer stays anchored', () => {
  const onboarding = source('app/[username]/player-initialization.tsx')

  assert.match(onboarding, /height: '100dvh'/)
  assert.match(onboarding, /overflowY: 'auto'/)
  assert.match(onboarding, /data-sticky-chat-composer/)
  assert.match(onboarding, /data-player-answer-composer/)
  assert.match(onboarding, /threadEndRef\.current\?\.scrollIntoView/)
  assert.match(onboarding, /placeholder="Balas System…"/)
})

test('Home uses one sticky answer composer when System needs clarification', () => {
  const home = source('app/[username]/today-conversation-shell.tsx')
  const layout = source('app/[username]/layout.tsx')

  assert.match(home, /onConversationInputModeChange/)
  assert.match(home, /data-sticky-chat-composer/)
  assert.match(home, /bottom: 'calc\(62px \+ env\(safe-area-inset-bottom\)\)'/)
  assert.match(home, /placeholder="Balas Superhuman…"/)
  assert.match(layout, /todayConversationNeedsInput/)
  assert.match(layout, /showUpdateComposer = showComposer && !\(pathname === todayPath && todayConversationNeedsInput\)/)
  assert.match(layout, /onConversationInputModeChange=\{setTodayConversationNeedsInput\}/)
})
