const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const file = path.join(process.cwd(), 'app/[username]/today-conversation-shell.tsx')
const source = fs.readFileSync(file, 'utf8')

test('progression follow-up composer supports mobile voice input and keyboard-safe layout', () => {
  assert.match(source, /webkitSpeechRecognition/)
  assert.match(source, /Jawab dengan suara/)
  assert.match(source, /fontSize: 16/)
  assert.match(source, /minHeight: 44/)
  assert.doesNotMatch(source, /data-sticky-chat-composer[\s\S]{0,220}position: 'fixed'/)
})
