/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const { parseConsumerChatEnvelope } = require('../.domain-test-dist/lib/ai/chatgpt-consumer-provider.js')

test('consumer parser selects the correlated envelope from wrapped prose and extra JSON', () => {
  const text = [
    'Here is the result:',
    '```json',
    JSON.stringify({ requestId: 'wrong', operation: 'generate_daily_quests', schemaVersion: 'daily-quest.v1', payload: [] }),
    '```',
    'Final answer:',
    JSON.stringify({ requestId: 'expected', operation: 'generate_daily_quests', schemaVersion: 'daily-quest.v1', payload: [{ title: 'Quest' }] }),
  ].join('\n')

  const envelope = parseConsumerChatEnvelope(text, {
    requestId: 'expected',
    operation: 'generate_daily_quests',
    schemaVersion: 'daily-quest.v1',
  })

  assert.deepEqual(envelope.payload, [{ title: 'Quest' }])
})
