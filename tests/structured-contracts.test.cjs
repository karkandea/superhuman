/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  derivePlayerUnderstanding,
  generateDailyQuests,
} = require('../.domain-test-dist/lib/ai/orchestrator.js')

function playerBrief() {
  return {
    id: 'brief-1', version: 1, schemaVersion: 'player-brief.v1', reason: 'test',
    createdAt: '2026-08-18T11:00:00.000Z', generatedAt: '2026-08-18T11:00:00.000Z',
    player: { id: 'p1', name: 'Player', timezone: 'Asia/Jakarta' },
    activeUnderstandingIds: [], highlights: [],
    sections: { goals: [], obstacles: [], opportunities: [], constraints: [], preferences: [], relationships: [], events: [], priorities: [] },
    activeSignals: [], counts: { activeUnderstanding: 0, activeSignals: 0 },
  }
}

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
    playerBrief: playerBrief(),
    dailyContext: {
      id: 'dc1', userId: 'p1', contextDate: '2026-08-18', mode: 'context',
      text: 'Meetings until 17:00; lower available capacity today.',
      createdAt: '2026-08-18T00:00:00Z', updatedAt: '2026-08-18T00:00:00Z',
    },
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
    retrieval: { strategy: 'signals_plus_daily_context', limit: 32, reason: 'daily quest', dailyContextId: 'dc1', dailyContextMode: 'context' },
  }
}

function policyOutput() {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    candidateId: `c${index + 1}`,
    title: `Candidate ${index + 1}`,
    category: 'siang',
    difficulty: index === 0 ? 'medium' : 'easy',
    xp: 40 + index,
    rationale: 'Evidence-backed option.',
    sourceSignalIds: ['s1'],
    scores: {
      goalRelevance: 5,
      urgency: index === 0 ? 5 : 3,
      leverage: 4,
      obstacleRemoval: 3,
      actionability: 4,
      contextFit: 4,
      progressionValue: 3,
      redundancyPenalty: 1,
    },
  }))
  return {
    candidates,
    selections: [
      { candidateId: 'c1', kind: 'main', priority: 5, selectionReason: 'Highest leverage today.' },
      { candidateId: 'c2', kind: 'side', priority: 4, selectionReason: 'Supports the main quest.' },
    ],
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

test('daily quest request exposes candidate scoring and portfolio-selection contract', async () => {
  let request
  const deps = {
    provider: {
      id: 'test-provider',
      async invokeStructured(input) {
        request = input
        return { providerId: 'test-provider', modelId: 'test-model', output: policyOutput() }
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

  const result = await generateDailyQuests(deps, { playerId: 'p1', date: '2026-08-18' })

  assert.equal(request.schemaVersion, 'daily-quest.v2')
  assert.equal(request.context.playerBrief.version, 1)
  assert.equal(request.context.dailyContext.id, 'dc1')
  assert.deepEqual(request.responseContract.candidates[0].category, ['pagi', 'siang', 'malam', 'sepanjang_hari'])
  assert.deepEqual(request.responseContract.candidates[0].difficulty, ['easy', 'medium', 'hard'])
  assert.deepEqual(request.responseContract.selections[0].kind, ['main', 'side', 'maintenance', 'bonus'])
  assert.match(String(request.responseContract.candidates[0].scores.redundancyPenalty), /0\.\.5/)
  assert.equal(result.quests.filter(quest => quest.kind === 'main').length, 1)
})
