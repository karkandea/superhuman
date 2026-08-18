/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const { buildConsumerChatPrompt } = require('../.domain-test-dist/lib/ai/chatgpt-consumer-provider.js')

test('consumer prompt binds provenance ids to exact context collections', () => {
  const prompt = buildConsumerChatPrompt({
    operation: 'generate_daily_quests',
    schemaVersion: 'daily-quest.v1',
    instructions: 'Generate evidence-backed quests.',
    context: {
      playerId: 'p1',
      purpose: 'daily_quest',
      generatedAt: '2026-08-18T00:00:00Z',
      knowledgeEntries: [],
      signals: [{ id: 'signal-123', userId: 'p1', type: 'goal', summary: 'Ship MVP', importance: 5, confidence: 0.9, observedAt: '2026-08-18T00:00:00Z' }],
      recentQuestResults: [],
      retrieval: { strategy: 'signals', limit: 32, reason: 'bounded' },
    },
    responseContract: {
      type: 'array',
      items: { sourceSignalIds: 'non-empty array of ids from context.signals only' },
    },
  }, 'req-provenance')

  assert.match(prompt, /sourceSignalIds may only use CONTEXT_DATA\.signals\[\*\]\.id/)
  assert.match(prompt, /Never invent an ID and never substitute an ID from another collection/)
  assert.match(prompt, /signal-123/)
})
