const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const unit = fs.readFileSync('ops/worker-qa/superhuman-ai-qa-worker.service', 'utf8')
const startScript = fs.readFileSync('ops/worker-qa/start.sh', 'utf8')

test('QA config failure exits 78 and systemd does not restart-loop it', () => {
  assert.match(startScript, /exit 78/)
  assert.match(unit, /RestartPreventExitStatus=78/)
})
