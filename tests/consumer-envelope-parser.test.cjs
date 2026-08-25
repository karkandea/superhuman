/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ChatGptConsumerWebProvider,
  buildConsumerChatPrompt,
  parseConsumerChatEnvelope,
} = require('../.domain-test-dist/lib/ai/chatgpt-consumer-provider.js')

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

test('player-facing operations receive the shared Indonesian System voice contract', () => {
  const prompt = buildConsumerChatPrompt({
    operation: 'generate_daily_quests',
    schemaVersion: 'daily-quest.v4',
    instructions: 'Generate a quest.',
    context: { playerId: 'player-1', date: '2026-08-25' },
    responseContract: { type: 'object' },
  }, 'voice-test')

  assert.match(prompt, /SYSTEM VOICE system-voice\.id\.v1/)
  assert.match(prompt, /natural conversational Indonesian/)
  assert.match(prompt, /Address the player as "lo"/)
  assert.match(prompt, /Return no text before or after the JSON object/)
})

test('internal strategic map operation does not force player-facing voice into internal state', () => {
  const prompt = buildConsumerChatPrompt({
    operation: 'derive_progression_map',
    schemaVersion: 'progression-map.v1',
    instructions: 'Build the map.',
    context: { playerId: 'player-1', date: '2026-08-25' },
    responseContract: { type: 'object' },
  }, 'map-test')

  assert.doesNotMatch(prompt, /SYSTEM VOICE/)
})

test('consumer provider performs one targeted envelope repair before failing the whole job', async () => {
  const calls = []
  const ids = ['initial-request', 'repair-request']
  const transport = {
    async execute(input) {
      calls.push(input)
      if (calls.length === 1) {
        return {
          text: 'I would focus on one income path today.',
          modelLabel: 'chatgpt-consumer-high',
        }
      }
      return {
        text: JSON.stringify({
          requestId: 'repair-request',
          operation: 'choose_progression_target',
          schemaVersion: 'progression-target.v1',
          payload: {
            mode: 'progress',
            summary: 'Fokus ke satu jalur pemasukan dulu.',
          },
        }),
        modelLabel: 'chatgpt-consumer-high',
      }
    },
  }

  const provider = new ChatGptConsumerWebProvider(transport, {
    idFactory: () => ids.shift(),
    reasoningLevel: 'high',
  })

  const response = await provider.invokeStructured({
    operation: 'choose_progression_target',
    schemaVersion: 'progression-target.v1',
    instructions: 'Choose what should move today.',
    context: { playerId: 'player-1', date: '2026-08-25' },
    responseContract: { type: 'object' },
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].reasoningLevel, 'high')
  assert.equal(calls[1].reasoningLevel, 'high')
  assert.match(calls[1].prompt, /OUTPUT REPAIR:/)
  assert.match(calls[1].prompt, /previous attempt completed generation but failed/i)
  assert.equal(response.requestId, 'repair-request')
  assert.equal(response.outputRepairAttemptCount, 1)
  assert.equal(response.output.summary, 'Fokus ke satu jalur pemasukan dulu.')
})