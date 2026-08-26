const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const unit = fs.readFileSync('ops/worker-qa/superhuman-chatgpt-qa-browser.service', 'utf8')

test('QA browser does not import production worker environment', () => {
  assert.doesNotMatch(unit, /^EnvironmentFile=\/etc\/superhuman-ai\/consumer-worker\.env$/m)
  assert.match(unit, /^Environment=CHATGPT_CHROME_BIN=\/usr\/local\/bin\/superhuman-chrome$/m)
  assert.match(unit, /^Environment=SUPERHUMAN_DISPLAY_NUMBER=100$/m)
  assert.match(unit, /^Environment=CHATGPT_BROWSER_PROFILE_DIR=\/var\/lib\/superhuman-ai\/chatgpt-qa-profile$/m)
  assert.match(unit, /^Environment=CHATGPT_CDP_PORT=9223$/m)
})

test('QA Xvfb uses the host X11 socket namespace', () => {
  assert.doesNotMatch(unit, /^PrivateTmp=true$/m)
})
