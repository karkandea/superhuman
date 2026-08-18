/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  derivePlayerUnderstanding,
  generateDailyQuests,
} = require('../.domain-test-dist/lib/ai/orchestrator.js')

function understandingContext() {
  return {
    playerId: 'p1',
    purpose: 'understanding',
    generatedAt: '2026-08-18T11:00:00.000Z',
    knowledgeEntries: [{ id: 'k1', type: 'journal', text: 'I need to finish the proposal today.' }],
    signals: [],
    recentQuestResults: [],
    retrieval: { strategy: 'explicit_ids', limit: 24, reason: 'new update' },
  }
}

function dailyQuestContext() {
  return {
    playerId: 'p1',
    purpose: 'daily_quest',
    generatedAt: '2026-08-18T11:00:00.000Z',
    knowledgeEntries: [],
    signals: [{
      id: 's1',
      userId: 'p1',
      type: 'priority',
      summary: 'Proposal must be finished today',
      importance: 5,
      confidence: 0.95,
      observedAt: '2026-08-18T11:00:00.000Z',
    }],
    recentQuestResults: [],
    retrieval: { strategy: 'signals', limit: 32, reason: 'daily quest' },
  }
}

test('understanding request exposes only canonical understanding types to the model', async () => {
  let request
  const deps = {
    provider: {
      id: 'test-provider',
      async invokeStructured(input) {
        request = input
        return {
          providerId: 'test-provider',
          modelId: 'test-model',
          output: [{
            type: 'priority',
            summary: 'Proposal completion is a current priority.',
            confidence: 0.95,
            importance: 5,
            sourceKnowledgeEntryIds: ['k1'],
          }],
        }
      },
    },
    contextRetriever: { async retrieveForUnderstanding() { return understandingContext() } },
    repository: { async persistDerived() {} },
  }

  await derivePlayerUnderstanding(deps, { playerId: 'p1', knowledgeEntryIds: ['k1'] })

  assert.deepEqual(request.responseContract.items.type, [
    'goal', 'obstacle', 'opportunity', 'constraint', 'preference', 'relationship', 'event', 'priority',
  ])
  assert.match(request.instructions, /Every candidate type must be exactly one of/)
  assert.match(request.instructions, /Do not invent new type labels/)
})

test('daily quest request exposes validator-compatible category, kind, and difficulty enums', async () => {
  let request
  const deps = {
    provider: {
      id: 'test-provider',
      async invokeStructured(input) {
        request = input
        return {
          providerId: 'test-provider',
          modelId: 'test-model',
          output: [{
            title: 'Finish proposal draft',
            category: 'siang',
            kind: 'main',
            difficulty: 'medium',
            priority: 1,
            xp: 100,
            rationale: 'The proposal is the strongest active priority signal.',
            sourceSignalIds: ['s1'],
          }],
        }
      },
    },
    contextRetriever: { async retrieveForDailyQuest() { return dailyQuestContext() } },
    repository: {
      async findForDate() { return [] },
      async persistGeneratedBatch({ candidates }) {
        return candidates.map((candidate, index) => ({
          ...candidate,
          id: `q${index + 1}`,
          userId: 'p1',
          batchId: 'b1',
          questDate: '2026-08-18',
          source: 'ai',
          status: 'pending',
        }))
      },
    },
  }

  await generateDailyQuests(deps, { playerId: 'p1', date: '2026-08-18' })

  assert.deepEqual(request.responseContract.items.category, ['pagi', 'siang', 'malam', 'sepanjang_hari'])
  assert.deepEqual(request.responseContract.items.kind, ['main', 'side', 'maintenance', 'bonus'])
  assert.deepEqual(request.responseContract.items.difficulty, ['easy', 'medium', 'hard'])
})
