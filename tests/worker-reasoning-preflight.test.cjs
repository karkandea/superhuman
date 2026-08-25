const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('consumer worker blocks startup until configured reasoning level is verified', () => {
  const workerPackage = JSON.parse(source('workers/chatgpt-consumer/package.json'))
  const preflight = source('workers/chatgpt-consumer/reasoning-level-preflight.mjs')

  assert.match(workerPackage.scripts.start, /npm run preflight/)
  assert.match(workerPackage.scripts.once, /npm run preflight/)
  assert.match(preflight, /CHATGPT_REASONING_LEVEL \|\| 'high'/)
  assert.match(preflight, /verifyFreshChatPersistence/)
  assert.match(preflight, /reasoning-preflight.*verified/)
  assert.match(preflight, /DO_NOT_RESTART_EXIT_CODE = 78/)
})

test('systemd installer configures High reasoning and avoids restart storms when preflight blocks', () => {
  const installer = source('workers/chatgpt-consumer/install-linux-systemd.sh')

  assert.match(installer, /CHATGPT_REASONING_LEVEL=high/)
  assert.match(installer, /RestartPreventExitStatus=78/)
  assert.match(installer, /StartLimitBurst=3/)
})