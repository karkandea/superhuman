/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { normalizeDailyContextInput } = require('../.domain-test-dist/lib/daily-context.js')
const {
  QUEST_POLICY_VERSION,
  validateQuestPolicyDecision,
} = require('../.domain-test-dist/lib/quest-policy.js')
const { generateDailyQuests } = require('../.domain-test-dist/lib/ai/orchestrator.js')

function brief() {
  return {
    id: 'brief-1', version: 2, schemaVersion: 'player-brief.v1', reason: 'test',
    createdAt: '2026-08-19T00:00:00Z', generatedAt: '2026-08-19T00:00:00Z',
    player: { id: 'p1', name: 'Player', timezone: 'Asia/Jakarta' },
    activeUnderstandingIds: [], highlights: [],
    sections: { goals: [], obstacles: [], opportunities: [], constraints: [], preferences: [], relationships: [], events: [], priorities: [] },
    activeSignals: [], counts: { activeUnderstanding: 0, activeSignals: 1 },
  }
}

function todayContext(mode = 'normal') {
  return {
    id: 'dc-1', userId: 'p1', contextDate: '2026-08-19', mode,
    text: mode === 'normal' ? '' : 'Meeting 09:00–17:00, family dinner tonight.',
    createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
  }
}

function candidate(index) {
  return {
    candidateId: `c${index}`,
    title: `Candidate action ${index}`,
    category: index % 2 ? 'siang' : 'pagi',
    difficulty: index === 1 ? 'medium' : 'easy',
    xp: 20 + index,
    rationale: `Evidence-backed option ${index}`,
    sourceSignalIds: ['s1'],
    scores: {
      goalRelevance: 4,
      urgency: index === 1 ? 5 : 2,
      leverage: 4,
      obstacleRemoval: 3,
      actionability: 5,
      contextFit: 4,
      progressionValue: 3,
      redundancyPenalty: 1,
    },
  }
}

function validDecision() {
  return {
    candidates: Array.from({ length: 8 }, (_, index) => candidate(index + 1)),
    selections: [
      { candidateId: 'c1', kind: 'main', priority: 5, selectionReason: 'Highest leverage and urgency today' },
      { candidateId: 'c2', kind: 'side', priority: 4, selectionReason: 'Supports the main bottleneck' },
      { candidateId: 'c3', kind: 'maintenance', priority: 3, selectionReason: 'Keeps baseline stability without crowding the day' },
    ],
  }
}

test('Daily Context is either a normal-day acknowledgement or bounded temporary natural language', () => {
  assert.deepEqual(normalizeDailyContextInput({ mode: 'normal' }), { mode: 'normal', text: '' })
  assert.deepEqual(
    normalizeDailyContextInput({ mode: 'context', text: '  Full meeting day, only free after 20:00.  ' }),
    { mode: 'context', text: 'Full meeting day, only free after 20:00.' },
  )
  assert.throws(() => normalizeDailyContextInput({ mode: 'normal', text: 'meeting' }), /must not include custom context/)
  assert.throws(() => normalizeDailyContextInput({ mode: 'context', text: '   ' }), /Tell the System/)
  assert.throws(() => normalizeDailyContextInput({ mode: 'context', text: '🚀'.repeat(1100) }), /under 4 KB/)
})

test('Quest Policy enforces candidate-first portfolio selection with exactly one Main Quest', () => {
  const decision = validateQuestPolicyDecision(validDecision(), new Set(['s1']))
  assert.equal(decision.candidates.length, 8)
  assert.equal(decision.quests.length, 3)
  assert.equal(decision.quests.filter(quest => quest.kind === 'main').length, 1)
  assert.equal(decision.quests[0].priority, 5)

  const invalid = validDecision()
  invalid.selections[1] = { ...invalid.selections[1], kind: 'main' }
  assert.throws(() => validateQuestPolicyDecision(invalid, new Set(['s1'])), /exactly one Main Quest/)
})

test('Quest Policy rejects selection outside candidate pool and provenance outside retrieved signals', () => {
  const outsideCandidate = validDecision()
  outsideCandidate.selections[0] = { ...outsideCandidate.selections[0], candidateId: 'missing' }
  assert.throws(() => validateQuestPolicyDecision(outsideCandidate, new Set(['s1'])), /outside the candidate pool/)

  const outsideSignal = validDecision()
  outsideSignal.candidates[0] = { ...outsideSignal.candidates[0], sourceSignalIds: ['other'] }
  assert.throws(() => validateQuestPolicyDecision(outsideSignal, new Set(['s1'])), /outside retrieved context/)
})

test('first quest generation stops before provider when Daily Context is missing', async () => {
  let providerCalls = 0
  const result = await generateDailyQuests({
    provider: { id: 'test', async invokeStructured() { providerCalls += 1; throw new Error('provider must not run') } },
    contextRetriever: {
      async retrieveForDailyQuest() {
        return {
          playerId: 'p1', purpose: 'daily_quest', generatedAt: '2026-08-19T00:00:00Z',
          playerBrief: brief(), dailyContext: null, knowledgeEntries: [],
          signals: [{ id: 's1', userId: 'p1', type: 'goal', summary: 'Ship project', importance: 5, confidence: 0.9, observedAt: '2026-08-18T00:00:00Z' }],
          recentQuestResults: [], retrieval: { strategy: 'bounded', limit: 32, reason: 'test' },
        }
      },
    },
    repository: { async findForDate() { return [] }, async persistGeneratedBatch() { throw new Error('must not persist') } },
  }, { playerId: 'p1', date: '2026-08-19' })

  assert.equal(result.source, 'awaiting_context')
  assert.equal(result.quests.length, 0)
  assert.equal(providerCalls, 0)
})

test('Daily Context plus policy decision persists only the selected portfolio with bounded audit metadata', async () => {
  let persisted
  let invoked
  const response = validDecision()
  const result = await generateDailyQuests({
    provider: {
      id: 'test',
      async invokeStructured(request) {
        invoked = request
        return { providerId: 'test', modelId: 'model', requestId: 'req-1', output: response }
      },
    },
    contextRetriever: {
      async retrieveForDailyQuest() {
        return {
          playerId: 'p1', purpose: 'daily_quest', generatedAt: '2026-08-19T00:00:00Z',
          playerBrief: brief(), dailyContext: todayContext('context'), knowledgeEntries: [],
          signals: [{ id: 's1', userId: 'p1', type: 'goal', summary: 'Ship project', importance: 5, confidence: 0.9, observedAt: '2026-08-18T00:00:00Z' }],
          recentQuestResults: [{ id: 'r1', questId: 'q1', outcome: 'failed', recordedAt: '2026-08-18T12:00:00Z', questTitle: 'Oversized task', questDifficulty: 'hard' }],
          retrieval: { strategy: 'bounded', limit: 32, reason: 'test', dailyContextId: 'dc-1', dailyContextMode: 'context' },
        }
      },
    },
    repository: {
      async findForDate() { return [] },
      async persistGeneratedBatch(input) {
        persisted = input
        return input.candidates.map((quest, index) => ({
          id: `q${index + 1}`, userId: 'p1', batchId: 'b1', questDate: '2026-08-19',
          ...quest, source: 'ai', status: 'pending',
        }))
      },
    },
  }, { playerId: 'p1', date: '2026-08-19' })

  assert.equal(result.source, 'generated')
  assert.equal(result.quests.length, 3)
  assert.equal(result.quests.filter(quest => quest.kind === 'main').length, 1)
  assert.equal(invoked.schemaVersion, 'daily-quest.v2')
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
})

test('worker and Today page preserve the daily lifecycle boundary', () => {
  const worker = fs.readFileSync(path.join(process.cwd(), 'workers/chatgpt-consumer/worker-v2.mjs'), 'utf8')
  const today = fs.readFileSync(path.join(process.cwd(), 'app/[username]/page.tsx'), 'utf8')
  assert.match(worker, /generated\.source === 'awaiting_context'/)
  assert.match(worker, /awaitingDailyContext: true/)
  assert.match(today, /DailyContextCheckin/)
  assert.match(today, /SYSTEM CHECK-IN/)
  assert.match(today, /questReady && \(\s*<div id="update-system"/)
})
