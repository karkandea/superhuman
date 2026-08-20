/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const { FakeAiProvider } = require('../.domain-test-dist/lib/ai/fake-ai-provider.js')
const {
  refreshProgressionMap,
  chooseProgressionTarget,
} = require('../.domain-test-dist/lib/ai/progression-intelligence-core.js')
const {
  generateDailyQuestsWithIntelligence,
} = require('../.domain-test-dist/lib/ai/daily-quest-intelligence.js')

const signals = [
  { id: 's-goal', userId: 'p1', type: 'goal', summary: 'Land first paid analytics project', importance: 5, confidence: 0.95, observedAt: '2026-08-20T00:00:00Z' },
  { id: 's-blocker', userId: 'p1', type: 'obstacle', summary: 'Portfolio case study is not convincing yet', importance: 5, confidence: 0.9, observedAt: '2026-08-20T00:00:00Z' },
]

const playerBrief = {
  id: 'brief-1', version: 2, schemaVersion: 'player-brief.v1', reason: 'test',
  createdAt: '2026-08-20T00:00:00Z', generatedAt: '2026-08-20T00:00:00Z',
  player: { id: 'p1', name: 'QA', timezone: 'Asia/Jakarta' },
  activeUnderstandingIds: [], highlights: [],
  sections: { goals: [], obstacles: [], opportunities: [], constraints: [], preferences: [], relationships: [], events: [], priorities: [] },
  activeSignals: [], counts: { activeUnderstanding: 0, activeSignals: 2 },
}

const dailyContext = {
  id: 'dc-1', userId: 'p1', contextDate: '2026-08-20', mode: 'context',
  text: 'I have 30 focused minutes tonight.', createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-20T00:00:00Z',
}

const baseContext = {
  playerId: 'p1', purpose: 'daily_quest', generatedAt: '2026-08-20T00:00:00Z',
  playerBrief, dailyContext, knowledgeEntries: [], signals, recentQuestResults: [], activeQuests: [],
  retrieval: { strategy: 'fake-ai-integration', limit: 32, reason: 'deterministic test' },
}

const mapBody = {
  goals: [{ nodeId: 'g1', summary: 'Land first paid analytics project', priority: 5, confidence: 0.95, sourceSignalIds: ['s-goal'] }],
  proximalOutcomes: [{ nodeId: 'p1', goalId: 'g1', summary: 'Portfolio case study is credible enough to show prospects', importance: 5, confidence: 0.9, sourceSignalIds: ['s-goal', 's-blocker'] }],
  bottlenecks: [{ nodeId: 'b1', outcomeIds: ['p1'], summary: 'Case study quality is still weak', importance: 5, confidence: 0.9, sourceSignalIds: ['s-blocker'] }],
  opportunities: [],
  uncertainties: ['External prospect validation is not available yet.'],
}

function candidate(index) {
  return {
    candidateId: `c${index}`,
    title: `Improve case-study slice ${index}`,
    category: 'malam',
    difficulty: 'easy',
    xp: 25,
    rationale: 'Directly improves the current portfolio bottleneck.',
    sourceSignalIds: ['s-goal', 's-blocker'],
    strategicChain: {
      goalId: 'g1', proximalOutcomeId: 'p1', driverType: 'bottleneck', driverId: 'b1',
      causalReason: 'A bounded improvement makes the case study easier for a prospect to evaluate.',
    },
    feasibility: { feasibleToday: true, receptivity: 'high', estimatedMinutes: 20, reason: 'Fits the 30-minute Daily Context.' },
    executionContract: {
      action: `Revise one existing case-study slice ${index}`,
      completionCondition: `One existing slice ${index} is clearer without adding scope`,
      appropriateContext: 'One focused evening block',
      dose: '20 minutes, one existing slice',
    },
    scores: {
      goalRelevance: 5, urgency: 4, leverage: 5, obstacleRemoval: 5,
      actionability: 5, contextFit: 5, progressionValue: 5, redundancyPenalty: index === 1 ? 0 : 2,
    },
  }
}

test('FakeAiProvider consumes deterministic fixtures and rejects unexpected model calls', async () => {
  const provider = new FakeAiProvider({ fixtures: [
    { operation: 'derive_progression_map', output: mapBody },
  ] })

  const response = await provider.invokeStructured({
    operation: 'derive_progression_map', schemaVersion: 'progression-map.v1', instructions: 'test',
    context: baseContext, responseContract: { type: 'object' },
  })

  assert.equal(response.providerId, 'fake-ai')
  assert.equal(response.modelId, 'fake-model')
  assert.equal(response.requestId, 'fake-request-1')
  assert.equal(provider.calls.length, 1)
  assert.equal(provider.remainingFixtures(), 0)
  await assert.rejects(() => provider.invokeStructured({
    operation: 'generate_daily_quests', schemaVersion: 'daily-quest.v3', instructions: 'unexpected',
    context: baseContext, responseContract: { type: 'object' },
  }), /no fixture for operation generate_daily_quests/)
})

test('one FakeAiProvider drives map -> target -> quest persistence without ChatGPT', async () => {
  const provider = new FakeAiProvider({ fixtures: [
    { operation: 'derive_progression_map', output: mapBody },
    { operation: 'choose_progression_target', output: {
      mode: 'progress', summary: 'Improve one bounded case-study slice', primaryGoalId: 'g1',
      proximalOutcomeIds: ['p1'], bottleneckIds: ['b1'], opportunityIds: [], maxQuestCount: 1,
      rationale: 'This is the strongest causal move that fits tonight capacity.',
    } },
    { operation: 'generate_daily_quests', output: {
      candidates: Array.from({ length: 8 }, (_, index) => candidate(index + 1)),
      selections: [{ candidateId: 'c1', kind: 'main', priority: 5, selectionReason: 'Highest leverage with the best context fit.' }],
    } },
  ] })

  let currentMap = null
  let target = null
  let attachedMetadata = null
  const store = {
    loadCurrentProgressionMap: async () => currentMap,
    loadCurrentPlayerResponseModel: async () => null,
    loadQuestResponseEvents: async () => [],
    loadProgressionTargetForDate: async () => target,
    hasNoQuestPlanForDate: async () => false,
    persistProgressionMap: async input => {
      currentMap = {
        id: 'map-1', version: 1, schemaVersion: 'progression-map.v1', reason: 'strategic_state_refresh',
        generatedAt: input.generatedAt, createdAt: input.generatedAt, ...input.map,
      }
      return currentMap
    },
    persistProgressionTarget: async input => {
      target = {
        id: 'target-1', userId: input.playerId, targetDate: input.date,
        progressionMapId: input.progressionMapId, playerResponseModelId: input.playerResponseModelId,
        dailyContextId: input.dailyContextId, schemaVersion: 'progression-target.v1',
        createdAt: '2026-08-20T00:00:00Z', ...input.decision,
      }
      return target
    },
    attachQuestMetadata: async input => { attachedMetadata = input.items },
    persistNoQuestPlan: async () => { throw new Error('no-quest persistence should not run') },
  }

  const contextRetriever = { retrieveForDailyQuest: async () => baseContext }
  const repository = {
    findForDate: async () => [],
    persistGeneratedBatch: async ({ candidates }) => candidates.map((quest, index) => ({
      id: `q${index + 1}`, userId: 'p1', batchId: 'batch-1', questDate: '2026-08-20',
      source: 'ai', status: 'pending', ...quest,
    })),
  }

  const map = await refreshProgressionMap({ provider, contextRetriever, store }, { playerId: 'p1', date: '2026-08-20' })
  assert.equal(map.id, 'map-1')

  const chosen = await chooseProgressionTarget({ provider, contextRetriever, store }, { playerId: 'p1', date: '2026-08-20' })
  assert.equal(chosen.maxQuestCount, 1)

  const generated = await generateDailyQuestsWithIntelligence({ provider, contextRetriever, repository, progressionStore: store }, { playerId: 'p1', date: '2026-08-20' })
  assert.equal(generated.source, 'generated')
  assert.equal(generated.quests.length, 1)
  assert.equal(generated.quests[0].candidateId, 'c1')
  assert.equal(attachedMetadata.length, 1)
  assert.equal(attachedMetadata[0].strategicChain.driverId, 'b1')
  assert.deepEqual(provider.calls.map(call => call.request.operation), [
    'derive_progression_map', 'choose_progression_target', 'generate_daily_quests',
  ])
  provider.assertExhausted()
})
