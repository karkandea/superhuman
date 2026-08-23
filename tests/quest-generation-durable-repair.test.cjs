/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { FakeAiProvider } = require('../.domain-test-dist/lib/ai/fake-ai-provider.js')
const { generateDailyQuestsWithIntelligence } = require('../.domain-test-dist/lib/ai/daily-quest-intelligence.js')
const { deterministicQuestXp } = require('../.domain-test-dist/lib/quest-intelligence-policy.js')

const SIGNALS = [
  { id: 's-goal', userId: 'p1', type: 'goal', summary: 'Improve finances', importance: 5, confidence: 0.9, observedAt: '2026-08-23T00:00:00Z' },
  { id: 's-blocker', userId: 'p1', type: 'obstacle', summary: 'Too many directions', importance: 5, confidence: 0.9, observedAt: '2026-08-23T00:00:00Z' },
]
const MAP = {
  id: 'map-1', version: 1, schemaVersion: 'progression-map.v1', reason: 'test', generatedAt: '2026-08-23T00:00:00Z', createdAt: '2026-08-23T00:00:00Z',
  goals: [{ nodeId: 'g1', summary: 'Improve finances', priority: 5, confidence: 0.9, sourceSignalIds: ['s-goal'] }],
  proximalOutcomes: [{ nodeId: 'o1', goalId: 'g1', summary: 'Choose one developer direction', importance: 5, confidence: 0.8, sourceSignalIds: ['s-goal'] }],
  bottlenecks: [{ nodeId: 'b1', outcomeIds: ['o1'], summary: 'Direction ambiguity', importance: 5, confidence: 0.9, sourceSignalIds: ['s-blocker'] }],
  opportunities: [], uncertainties: [],
}
const TARGET = {
  id: 'target-1', userId: 'p1', targetDate: '2026-08-23', progressionMapId: 'map-1', dailyContextId: 'dc-1', schemaVersion: 'progression-target.v1', createdAt: '2026-08-23T00:00:00Z',
  mode: 'progress', summary: 'Narrow direction', primaryGoalId: 'g1', proximalOutcomeIds: ['o1'], bottleneckIds: ['b1'], opportunityIds: [], maxQuestCount: 2, rationale: 'Remove ambiguity.',
}
const BRIEF = {
  id: 'brief-1', version: 1, schemaVersion: 'player-brief.v1', reason: 'test', createdAt: '2026-08-23T00:00:00Z', generatedAt: '2026-08-23T00:00:00Z',
  player: { id: 'p1', name: 'QA', timezone: 'Asia/Jakarta' }, activeUnderstandingIds: [], highlights: [],
  sections: { goals: [], obstacles: [], opportunities: [], constraints: [], preferences: [], relationships: [], events: [], priorities: [] },
  activeSignals: [], counts: { activeUnderstanding: 0, activeSignals: 2 },
}
const CONTEXT = {
  playerId: 'p1', purpose: 'daily_quest', generatedAt: '2026-08-23T00:00:00Z', playerBrief: BRIEF,
  dailyContext: { id: 'dc-1', userId: 'p1', contextDate: '2026-08-23', mode: 'normal', text: '', createdAt: '2026-08-23T00:00:00Z', updatedAt: '2026-08-23T00:00:00Z' },
  knowledgeEntries: [], signals: SIGNALS, recentQuestResults: [], retrieval: { strategy: 'test', limit: 32, reason: 'test' },
}

function candidate(index) {
  return {
    candidateId: `c${index}`,
    title: `Action ${index}`,
    category: 'sepanjang_hari',
    difficulty: index === 1 ? 'medium' : 'easy',
    sourceSignalIds: ['s-goal', 's-blocker'],
    strategicChain: { goalId: 'g1', proximalOutcomeId: 'o1', driverType: 'bottleneck', driverId: 'b1', causalReason: 'Reduces direction ambiguity.' },
    feasibility: { feasibleToday: true, receptivity: 'high', estimatedMinutes: 20, reason: 'Fits today.' },
    executionContract: { action: `Do action ${index}`, completionCondition: `Action ${index} completed`, appropriateContext: 'One focused block', dose: '20 minutes' },
  }
}

function output(count) {
  return {
    candidates: Array.from({ length: count }, (_, i) => candidate(i + 1)),
    selections: [{ candidateId: 'c1', kind: 'main', selectionReason: 'Highest leverage.' }],
  }
}

function deps(provider) {
  let persisted = null
  return {
    dependencies: {
      provider,
      contextRetriever: { retrieveForDailyQuest: async () => CONTEXT },
      repository: {
        findForDate: async () => [],
        persistGeneratedBatch: async ({ candidates }) => {
          persisted = candidates
          return candidates.map((quest, index) => ({ id: `q${index + 1}`, userId: 'p1', batchId: 'batch-1', questDate: '2026-08-23', source: 'ai', status: 'pending', ...quest }))
        },
      },
      progressionStore: {
        hasNoQuestPlanForDate: async () => false,
        loadCurrentProgressionMap: async () => MAP,
        loadCurrentPlayerResponseModel: async () => null,
        loadProgressionTargetForDate: async () => TARGET,
        loadQuestResponseEvents: async () => [],
        persistNoQuestPlan: async () => {},
        attachQuestMetadata: async () => {},
      },
    },
    persisted: () => persisted,
  }
}

test('quest output validator gets exactly one targeted repair before persistence', async () => {
  const provider = new FakeAiProvider({ fixtures: [
    { operation: 'generate_daily_quests', output: output(3), requestId: 'initial-request' },
    { operation: 'repair_daily_quest_output', output: output(4), requestId: 'repair-request' },
  ] })
  const setup = deps(provider)
  const result = await generateDailyQuestsWithIntelligence(setup.dependencies, { playerId: 'p1', date: '2026-08-23' })
  assert.equal(provider.calls.length, 2)
  assert.deepEqual(provider.calls.map(call => call.request.operation), ['generate_daily_quests', 'repair_daily_quest_output'])
  assert.equal(result.repairAttemptCount, 1)
  assert.equal(result.requestId, 'repair-request')
  assert.equal(result.quests.length, 1)
  assert.equal(setup.persisted().length, 1)
  assert.equal(setup.persisted()[0].priority, 5)
  assert.equal(setup.persisted()[0].xp, deterministicQuestXp('medium', 'main'))
  assert.equal(provider.calls[1].request.context.questRepair.validatorCode, 'candidate_pool_invalid')
})

test('failed repair stops after two total model calls and exposes validator code', async () => {
  const provider = new FakeAiProvider({ fixtures: [
    { operation: 'generate_daily_quests', output: output(3) },
    { operation: 'repair_daily_quest_output', output: output(2) },
  ] })
  const setup = deps(provider)
  await assert.rejects(
    () => generateDailyQuestsWithIntelligence(setup.dependencies, { playerId: 'p1', date: '2026-08-23' }),
    error => {
      assert.equal(error.repairAttemptCount, 1)
      assert.equal(error.validatorCode, 'candidate_pool_invalid')
      assert.match(error.message, /repair failed/)
      return true
    },
  )
  assert.equal(provider.calls.length, 2)
  assert.equal(provider.remainingFixtures(), 0)
  assert.equal(setup.persisted(), null)
})

test('quest v4 contract keeps semantic decisions in model and mechanics in code', async () => {
  const provider = new FakeAiProvider({ fixtures: [{ operation: 'generate_daily_quests', output: output(4) }] })
  const setup = deps(provider)
  await generateDailyQuestsWithIntelligence(setup.dependencies, { playerId: 'p1', date: '2026-08-23' })
  const request = provider.calls[0].request
  const candidateContract = request.responseContract.candidates[0]
  const selectionContract = request.responseContract.selections[0]
  assert.equal(request.schemaVersion, 'daily-quest.v4')
  assert.equal('xp' in candidateContract, false)
  assert.equal('rationale' in candidateContract, false)
  assert.equal('scores' in candidateContract, false)
  assert.equal('priority' in selectionContract, false)
  assert.match(request.instructions, /System owns XP and priority mechanics/)
})

test('durable step ledger stores bounded diagnostics and worker does not retry model contract failures', () => {
  const migration = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/add_durable_progression_steps.sql'), 'utf8')
  const worker = fs.readFileSync(path.join(process.cwd(), 'workers/chatgpt-consumer/worker-v2.mjs'), 'utf8')
  assert.match(migration, /create table if not exists public\.progression_run_steps/)
  assert.match(migration, /validator_code text/)
  assert.match(migration, /latency_ms integer/)
  assert.match(migration, /repair_attempt_count smallint/)
  assert.match(worker, /new WorkerError\('model_output_invalid', message, false\)/)
  assert.match(worker, /new WorkerError\('inference_failed', message, false\)/)
  assert.match(worker, /'quest_generation'/)
  assert.match(worker, /repairAttemptCount: generated\.repairAttemptCount/)
})
