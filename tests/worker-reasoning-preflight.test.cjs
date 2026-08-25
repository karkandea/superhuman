const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('consumer worker blocks startup until configured reasoning level is verified', () => {
  const workerPackage = JSON.parse(source('workers/chatgpt-consumer/package.json'))
  const preflight = source('workers/chatgpt-consumer/reasoning-level-preflight-v3.mjs')

  assert.match(workerPackage.scripts.start, /npm run preflight/)
  assert.match(workerPackage.scripts.once, /npm run preflight/)
  assert.match(workerPackage.scripts.preflight, /reasoning-level-preflight-v3\.mjs/)
  assert.match(preflight, /CHATGPT_REASONING_LEVEL \|\| 'high'/)
  assert.match(preflight, /verifyFreshChat/)
  assert.match(preflight, /reasoning-preflight.*verified/)
  assert.match(preflight, /DO_NOT_RESTART_EXIT_CODE = 78/)
})

test('reasoning preflight recognizes the actual ChatGPT High aria-haspopup menu trigger', () => {
  const preflight = source('workers/chatgpt-consumer/reasoning-level-preflight-v3.mjs')

  assert.match(preflight, /\[aria-haspopup="menu"\]/)
  assert.match(preflight, /isExactLevel/)
  assert.match(preflight, /findReasoningTrigger/)
  assert.match(preflight, /detected current=/)
  assert.match(preflight, /EXCLUDED.*profile.*account.*sidebar/)
})

test('reasoning preflight selects High when another exact reasoning trigger is active', () => {
  const preflight = source('workers/chatgpt-consumer/reasoning-level-preflight-v3.mjs')

  assert.match(preflight, /findReasoningOption/)
  assert.match(preflight, /selecting=\$\{level\}/)
  assert.match(preflight, /selected current=/)
  assert.match(preflight, /force: true/)
})

test('non-root systemd installer configures High reasoning and avoids restart storms when preflight blocks', () => {
  const installer = source('workers/chatgpt-consumer/install-linux-systemd.sh')

  assert.match(installer, /CHATGPT_REASONING_LEVEL=high/)
  assert.match(installer, /RestartPreventExitStatus=78/)
  assert.match(installer, /StartLimitBurst=3/)
})

test('root-managed production bootstrap persists the same High reasoning contract', () => {
  const bootstrap = source('workers/chatgpt-consumer/bootstrap-vps-root.sh')

  assert.match(bootstrap, /ENV_FILE="\$CONFIG_DIR\/consumer-worker\.env"/)
  assert.match(bootstrap, /STATE_DIR="\/var\/lib\/superhuman-ai"/)
  assert.match(bootstrap, /CHATGPT_REASONING_LEVEL=high/)
  assert.match(bootstrap, /CHATGPT_REASONING_PREFLIGHT_TIMEOUT_MS=45000/)
  assert.match(bootstrap, /RestartPreventExitStatus=78/)
  assert.match(bootstrap, /StartLimitBurst=3/)
})

test('existing VPS runtime can be upgraded in place without replacing its browser profile or backend secret', () => {
  const upgrade = source('workers/chatgpt-consumer/upgrade-vps-reasoning-policy.sh')

  assert.match(upgrade, /ENV_FILE="\/etc\/superhuman-ai\/consumer-worker\.env"/)
  assert.match(upgrade, /set_env_value CHATGPT_REASONING_LEVEL high/)
  assert.match(upgrade, /set_env_value CHATGPT_REASONING_PREFLIGHT_TIMEOUT_MS 45000/)
  assert.match(upgrade, /RestartPreventExitStatus=78/)
  assert.match(upgrade, /npm run preflight/)
  assert.match(upgrade, /systemctl restart "\$WORKER_SERVICE"/)
  assert.doesNotMatch(upgrade, /SUPABASE_SECRET_KEY=.*print/)
})