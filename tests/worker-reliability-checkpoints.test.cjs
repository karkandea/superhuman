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
  assert.match(source, /webSearchSelected/)
  assert.match(source, /tool_state_invalid/)
})

test('composer verification tolerates rich-editor whitespace normalization but rejects truncation', async () => {
  const {
    normalizeComposerVerificationText,
    composerTextMatches,
    composerVerificationLengths,
  } = await import('../workers/chatgpt-consumer/composer-verification.mjs')

  const prompt = 'REQUEST_ID: abc\n\nCONTEXT_DATA:\n{ "goal": "ship safely" }\n'
  const richEditorText = 'REQUEST_ID: abc\u00a0\n CONTEXT_DATA:  { "goal": "ship safely" }'

  assert.equal(
    normalizeComposerVerificationText(prompt),
    normalizeComposerVerificationText(richEditorText),
  )
  assert.equal(composerTextMatches(prompt, [richEditorText]), true)
  assert.equal(composerTextMatches(prompt, ['REQUEST_ID: abc CONTEXT_DATA:']), false)

  const lengths = composerVerificationLengths(prompt, ['REQUEST_ID: abc CONTEXT_DATA:'])
  assert.ok(lengths.expectedChars > lengths.actualChars)
})
