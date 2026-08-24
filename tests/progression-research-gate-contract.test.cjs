/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const source = fs.readFileSync('lib/progression-conversation.ts', 'utf8')

test('initial calibration research gate allows clarification but blocks action before research', () => {
  assert.match(source, /input\.requireResearch && \['quest', 'decide', 'wait'\]\.includes\(nextAction\)/)
  assert.doesNotMatch(source, /input\.requireResearch && nextAction !== 'research'/)
})
