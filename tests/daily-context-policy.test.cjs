/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  validateDailyContextInput,
} = require('../.domain-test-dist/lib/daily-context.js')
const {
  QUEST_POLICY_VERSION,
  validateQuestPolicyDecision,
} = require('../.domain-test-dist/lib/quest-policy.js')
const {
  generateDailyQuests,
} = require('../.domain-test-dist/lib/ai/orchestrator-core.js')

function context(overrides = {}) {
  return {
    playerId: 'p1',
    purpose: 'daily_quest',
    generatedAt: '2026-08-20T00:00:00.000Z',
    playerBrief: {
      id: 'brief-1', version: 1, schemaVersion: 'player-brief.v1', reason: 'test', createdAt: '2026-08-20T00:00:00.000Z', generatedAt: '2026-08-20T00:00:00.000Z',
      player: { id: 'p1', name: 'P1', timezone: 'Asia/Jakarta' },
      activeUnderstandingIds: [], highlights: [],
      sections: { goals: [], obstacles: [], opportunities: [], constraints: [], preferences: [], relationships: [], events: [], priorities: [] },
      activeSignals: [], counts: { activeUnderstanding: 0, activeSignals: 0 },
    },
    dailyContext: {
      id: 'dc-1', userId: 'p1', date: '2026-08-20', mode: 'normal', text: '', createdAt: '2026-08-20T00:00:00.000Z', lockedAt: null,
    },
    knowledgeEntries: [],
    signals: [{ id: 's1', type: 'goal', summary: 'ship', confidence: .9, importance: 5 }],
    recentQuestResults: [],
    activeQuests: [],
    retrieval: { strategy: 'test', limit: 32, reason: 'test' },
    ...overrides,
  }
}

test('Daily Context is either a normal-day acknowledgement or bounded temporary natural language', () => {
  assert.deepEqual(validateDailyContextInput({ mode: 'normal' }), { mode: 'normal', text: '' })
  assert.deepEqual(validateDailyContextInput({ mode: 'context', text: ' Meeting moved to noon. ' }), { mode: 'context', text: 'Meeting moved to noon.' })
  assert.throws(() => validateDailyContextInput({ mode: 'context', text: '' }), /required/)
  assert.throws(() => validateDailyContextInput({ mode: 'normal', text: 'extra' }), /must be empty/)
})

test('Quest Policy enforces candidate-first portfolio selection with exactly one Main Quest', () => {
  const decision = validateQuestPolicyDecision({
    candidates: [
      { id: 'c1', title: 'Main', category: 'morning', kind: 'main', difficulty: 'medium', priority: 5, xp: 30, rationale: 'r', sourceSignalIds: ['s1'], actionability: 1, leverage: 1, urgency: 1, friction: .2, cognitiveLoad: .3, physicalLoad: .1, fitToDailyContext: 1, score: .9 },
      { id: 'c2', title: 'Side', category: 'afternoon', kind: 'side', difficulty: 'easy', priority: 3, xp: 15, rationale: 'r', sourceSignalIds: ['s1'], actionability: .8, leverage: .6, urgency: .4, friction: .2, cognitiveLoad: .2, physicalLoad: .1, fitToDailyContext: .8, score: .6 },
    ],
    selectedCandidateIds: ['c1', 'c2'],
    portfolioReason: 'main plus one side',
  }, new Set(['s1']))
  assert.equal(decision.selectedCandidateIds.length, 2)
  assert.equal(decision.candidates.filter(candidate => decision.selectedCandidateIds.includes(candidate.id) && candidate.kind === 'main').length, 1)
})

test('Quest Policy rejects selection outside candidate pool and provenance outside retrieved signals', () => {
  assert.throws(() => validateQuestPolicyDecision({
    candidates: [{ id: 'c1', title: 'Main', category: 'morning', kind: 'main', difficulty: 'medium', priority: 5, xp: 30, rationale: 'r', sourceSignalIds: ['not-allowed'], actionability: 1, leverage: 1, urgency: 1, friction: .2, cognitiveLoad: .3, physicalLoad: .1, fitToDailyContext: 1, score: .9 }],
    selectedCandidateIds: ['c2'], portfolioReason: 'x',
  }, new Set(['s1'])))
})

test('first quest generation stops before provider when Daily Context is missing', async () => {
  let providerCalls = 0
  const repository = {
    findForDate: async () => [],
    persistBatch: async () => { throw new Error('should not persist') },
  }
  const result = await generateDailyQuests({
    provider: { id: 'test', invokeStructured: async () => { providerCalls += 1; throw new Error('should not call') } },
    contextRetriever: { retrieveForDailyQuest: async () => context({ dailyContext: null }) },
    repository,
  }, { playerId: 'p1', date: '2026-08-20' })
  assert.equal(result.source, 'awaiting_context')
  assert.equal(providerCalls, 0)
})

test('Daily Context plus policy decision persists only the selected portfolio with bounded audit metadata', async () => {
  let persisted = null
  let invoked = null
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    id: `c${index + 1}`,
    title: `Quest ${index + 1}`,
    category: index === 0 ? 'morning' : 'afternoon',
    kind: index === 0 ? 'main' : 'side',
    difficulty: 'easy',
    priority: index === 0 ? 5 : 3,
    xp: index === 0 ? 30 : 10,
    rationale: 'evidence', sourceSignalIds: ['s1'],
    actionability: 1, leverage: 1 - index * .05, urgency: .8, friction: .2, cognitiveLoad: .2, physicalLoad: .1, fitToDailyContext: 1, score: .9 - index * .05,
  }))
  const repository = {
    findForDate: async () => [],
    persistBatch: async input => { persisted = input; return { batchId: 'b1', quests: input.quests } },
  }
  const result = await generateDailyQuests({
    provider: {
      id: 'fake',
      invokeStructured: async request => {
        invoked = request
        return { output: { candidates, selectedCandidateIds: ['c1', 'c2'], portfolioReason: 'focus' }, providerId: 'fake', modelId: 'm', requestId: 'r' }
      },
    },
    contextRetriever: { retrieveForDailyQuest: async () => context() },
    repository,
  }, { playerId: 'p1', date: '2026-08-20' })
  assert.equal(result.source, 'generated')
  assert.equal(persisted.quests.length, 2)
  assert.match(invoked.instructions, /QUEST POLICY \/ CONSTITUTION/)
  assert.equal(persisted.context.retrieval.questPolicyVersion, QUEST_POLICY_VERSION)
  assert.equal(persisted.context.retrieval.questPolicyDecision.candidateCount, 8)
  assert.equal(persisted.context.dailyContext.id, 'dc-1')
})

test('migration keeps Daily Context temporary, owner-scoped, and locked after first quest generation', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/add_daily_context_quest_policy.sql'), 'utf8')
  assert.match(sql, /create table if not exists public\.daily_contexts/i)
  assert.match(sql, /unique \(user_id, context_date\)/i)
  assert.match(sql, /octet_length\(convert_to\(context_text,'UTF8'\)\) <= 4096/i)
  assert.match(sql, /enable row level security/i)
  assert.match(sql, /\(select auth\.uid\(\)\) = user_id/i)
  assert.match(sql, /locked after Daily Quest generation; use a Life Vault update instead/i)
  assert.match(sql, /Daily Context check-in required before first Daily Quest generation/i)
  assert.match(sql, /v_has_pending_materiality/)
  assert.match(sql, /v_has_unresolved_interrupt/)
  assert.match(sql, /v_has_pending_progression or \(not v_has_quests and v_has_daily_context\)/)
})

test('worker and Today page preserve the daily lifecycle boundary behind the consumer UI', () => {
  const worker = fs.readFileSync(path.join(process.cwd(), 'workers/chatgpt-consumer/worker-v2.mjs'), 'utf8')
  const today = fs.readFileSync(path.join(process.cwd(), 'app/[username]/page.tsx'), 'utf8')
  const checkin = fs.readFileSync(path.join(process.cwd(), 'app/[username]/daily-context-checkin.tsx'), 'utf8')
  const layout = fs.readFileSync(path.join(process.cwd(), 'app/[username]/layout.tsx'), 'utf8')
  assert.match(worker, /generated\.source === 'awaiting_context'/)
  assert.match(worker, /awaitingDailyContext: true/)
  assert.match(today, /DailyContextCheckin/)
  assert.match(checkin, /TODAY CHECK-IN/)
  assert.match(checkin, /NORMAL DAY/)
  assert.match(checkin, /SOMETHING CHANGED/)
  assert.doesNotMatch(today, /UpdateSystemComposer/)
  assert.match(layout, /showComposer = pathname === todayPath \|\| pathname === vaultPath/)
  assert.match(today, /No quest needed right now\./)
})
