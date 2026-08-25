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

test('every chat bubble carries the correct participant avatar and player identity', () => {
  const bubble = source('app/[username]/conversation-bubble.tsx')
  const history = source('app/[username]/history/sessions/[sessionId]/page.tsx')

  assert.match(bubble, /<SystemAvatar size=\{compact \? 24 : 28\}/)
  assert.match(bubble, /<PlayerAvatar size=\{compact \? 24 : 28\}/)
  assert.match(bubble, /playerName = 'Player'/)
  assert.match(bubble, /system \? 'SUPERHUMAN' : playerName/)
  assert.match(history, /playerName=\{username\}/)
})

test('active chat surfaces identify Superhuman and the player with a sticky animated participant header', () => {
  const header = source('app/[username]/conversation-header.tsx')
  const onboarding = source('app/[username]/player-initialization.tsx')
  const home = source('app/[username]/today-conversation-shell.tsx')

  assert.match(header, /data-conversation-header/)
  assert.match(header, /position: 'sticky'/)
  assert.match(header, />\s*Superhuman\s*</)
  assert.match(header, /data-player-identity/)
  assert.match(header, /data-superhuman-orb/)
  assert.match(header, /superhumanOrbDrift/)
  assert.match(header, /superhumanOrbActive/)
  assert.match(header, /prefers-reduced-motion/)
  assert.match(onboarding, /agentActive=\{agentActive\}/)
  assert.match(home, /agentActive=\{systemWorking\}/)
})

test('agent working state uses a three-dot waving typing indicator', () => {
  const header = source('app/[username]/conversation-header.tsx')
  const onboarding = source('app/[username]/player-initialization.tsx')
  const home = source('app/[username]/today-conversation-shell.tsx')

  assert.match(header, /data-agent-typing/)
  assert.match(header, /superhumanTypingWave/)
  assert.match(header, /typing-dot:nth-child\(2\)/)
  assert.match(header, /typing-dot:nth-child\(3\)/)
  assert.match(onboarding, /<AgentTypingIndicator/)
  assert.match(home, /<AgentTypingIndicator/)
})

test('onboarding keeps the thread scrollable while the active reply composer stays anchored', () => {
  const onboarding = source('app/[username]/player-initialization.tsx')

  assert.match(onboarding, /height: '100dvh'/)
  assert.match(onboarding, /overflowY: 'auto'/)
  assert.match(onboarding, /data-sticky-chat-composer/)
  assert.match(onboarding, /data-player-answer-composer/)
  assert.match(onboarding, /threadEndRef\.current\?\.scrollIntoView/)
  assert.match(onboarding, /placeholder="Balas Superhuman…"/)
})

test('final onboarding or adaptive answer automatically starts calibration without a second CTA', () => {
  const onboarding = source('app/[username]/player-initialization.tsx')

  assert.match(onboarding, /pendingAutomaticCalibration/)
  assert.match(onboarding, /autoCalibrationRef/)
  assert.match(onboarding, /void calibrate\(\)\.finally/)
  assert.match(onboarding, /requestPlayerInitializationCalibration/)
  assert.doesNotMatch(onboarding, /CEK LAGI →/)
  assert.doesNotMatch(onboarding, /LANJUT →/)
  assert.match(onboarding, /Gue lagi nyusun semua yang lo ceritain biar nyambung\./)
  assert.match(onboarding, /Mungkin agak lebih lama dari biasanya, tapi tenang aja jawaban lo tetap kesimpan\./)
})

test('Home uses one mobile-safe reply composer when System needs clarification', () => {
  const home = source('app/[username]/today-conversation-shell.tsx')
  const voice = source('app/[username]/progression-voice-answer-recorder.tsx')
  const layout = source('app/[username]/layout.tsx')

  assert.match(home, /onConversationInputModeChange/)
  assert.match(home, /data-sticky-chat-composer/)
  assert.match(home, /BALAS PERTANYAAN SYSTEM/)
  assert.match(home, /placeholder="Tulis jawaban lo…"/)
  assert.match(home, /fontSize: 16/)
  assert.match(home, /ProgressionVoiceAnswerRecorder/)
  assert.match(voice, /MediaRecorder/)
  assert.match(voice, /KIRIM SUARA →/)
  assert.match(home, /minHeight: 44/)
  assert.doesNotMatch(home, /bottom: 'calc\(62px \+ env\(safe-area-inset-bottom\)\)'/)
  assert.match(layout, /todayConversationNeedsInput/)
  assert.match(layout, /showUpdateComposer = showComposer && !\(pathname === todayPath && todayConversationNeedsInput\)/)
  assert.match(layout, /onConversationInputModeChange=\{setTodayConversationNeedsInput\}/)
})
