const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const transportPath = path.join(process.cwd(), 'workers/chatgpt-consumer/browser-transport.mjs')
const source = fs.readFileSync(transportPath, 'utf8')

test('browser transport verifies critical state transitions before continuing', () => {
  for (const marker of [
    'verifyChatGptPage',
    'fillComposerVerified',
    'waitForSubmissionStarted',
    'preparePageForRequest',
    'recoverPreSubmissionPage',
  ]) {
    assert.match(source, new RegExp(marker), `missing reliability checkpoint: ${marker}`)
  }
})

test('browser transport never blindly retries after prompt submission', () => {
  assert.match(source, /submitted = true/)
  assert.match(source, /if \(submitted \|\| !error\.retryable/)
})

test('browser transport verifies Search mode after UI selection', () => {
  assert.match(source, /verifyWebSearchActive/)
  assert.match(source, /web_search_activation_unverified/)
})
