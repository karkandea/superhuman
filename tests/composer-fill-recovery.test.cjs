const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('composer readiness requires an editable ChatGPT input', () => {
  const transport = source('workers/chatgpt-consumer/browser-transport.mjs')

  assert.match(transport, /composer && await composer\.isEditable\(\)\.catch\(\(\) => false\)/)
  assert.match(transport, /composer_not_found/)
})

test('a Playwright fill timeout is verified before being treated as failure', () => {
  const transport = source('workers/chatgpt-consumer/browser-transport.mjs')
  const start = transport.indexOf('async function fillComposerVerified')
  const end = transport.indexOf('async function waitForAssistantResponse', start)
  const fill = transport.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(fill, /timeoutUntil\(deadline, 60_000\)/)
  assert.match(fill, /fillError = error/)
  assert.match(fill, /const candidates = await composerTextCandidates\(composer\)/)
  assert.match(fill, /if \(composerTextMatches\(prompt, candidates\)\) return/)
  assert.ok(fill.indexOf('composerTextMatches(prompt, candidates)') < fill.indexOf('if (fillError)'))
  assert.match(fill, /composer_fill_timeout/)
  assert.match(fill, /composer_fill_unverified/)
})

test('prompt submission still happens only after verified composer fill', () => {
  const transport = source('workers/chatgpt-consumer/browser-transport.mjs')

  assert.ok(transport.indexOf('await fillComposerVerified(composer, prompt, deadline)') < transport.indexOf("checkpoint(correlationId, 'prompt_submit', 'checking')"))
  assert.ok(transport.indexOf("checkpoint(correlationId, 'prompt_submit', 'checking')") < transport.indexOf('submitted = true'))
})
