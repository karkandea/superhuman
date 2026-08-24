/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('worker runtime loads checkpoint observer for normal, once, and login modes', () => {
  const pkg = JSON.parse(source('workers/chatgpt-consumer/package.json'))
  for (const script of ['start', 'once', 'login']) {
    assert.match(pkg.scripts[script], /--import \.\/checkpoint-observer\.mjs/)
  }
})

test('checkpoint observer records duration for browser stage transitions', () => {
  const observer = source('workers/chatgpt-consumer/checkpoint-observer.mjs')
  assert.match(observer, /\[worker-step\]/)
  assert.match(observer, /durationMs=/)
  assert.match(observer, /stageStarts/)
  assert.match(observer, /START_STATUSES/)
  assert.match(observer, /TERMINAL_STATUSES/)
})

test('checkpoint observer attributes worker failures to the active browser stage', () => {
  const observer = source('workers/chatgpt-consumer/checkpoint-observer.mjs')
  assert.match(observer, /\[worker-failure\]/)
  assert.match(observer, /activeStage/)
  assert.match(observer, /requestId=/)
  assert.match(observer, /code=/)
  assert.match(observer, /process_exit/)
})
