/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  derivePlayerUnderstandingDelta,
} = require('../.domain-test-dist/lib/ai/orchestrator.js')
const {
  validateUnderstandingDelta,
} = require('../.domain-test-dist/lib/player-understanding.js')
const {
  buildConsumerChatPrompt,
} = require('../.domain-test-dist/lib/ai/chatgpt-consumer-provider.js')

function brief() {
  return {
    id: 'brief-37',
    version: 37,
    schemaVersion: 'player-brief.v1',
    reason: 'understanding_delta',
    createdAt: '2026-08-18T12:00:00.000Z',
    generatedAt: '2026-08-18T12:00:00.000Z',
    player: { id: 'p1', name: 'Arkan', timezone: 'Asia/Jakarta' },
    activeUnderstandingIds: ['u1'],
    highlights: [{ id: 'u1', type: 'priority', summary: 'Focus Australia', confidence: 0.9, importance: 5, lastObservedAt: '2026-08-18T12:00:00.000Z' }],
    sections: {
      goals: [], obstacles: [], opportunities: [], constraints: [], preferences: [], relationships: [], events: [],
      priorities: [{ id: 'u1', summary: 'Focus Australia', confidence: 0.9, importance: 5, lastObservedAt: '2026-08-18T12:00:00.000Z' }],
    },
    activeSignals: [],
    counts: { activeUnderstanding: 1, activeSignals: 0 },
  }
}

function context() {
  return {
    playerId: 'p1',
    purpose: 'understanding',
    generatedAt: '2026-08-18T13:00:00.000Z',
    playerBrief: brief(),
    knowledgeEntries: [{ id: 'k1', type: 'life_update', text: 'Interview Japan tomorrow at 10.' }],
    signals: [],
    recentQuestResults: [],
    activeQuests: [],
    retrieval: { strategy: 'canonical_player_brief_plus_activity_batch_and_recent_execution_context', limit: 24, reason: 'delta' },
  }
}

test('understanding delta allows a no-op without rewriting the Player Brief', async () => {
  let request
  let persisted
  const deps = {
    provider: {
      id: 'test-provider',
      async invokeStructured(input) {
        request = input
        return { providerId: 'test-provider', modelId: 'test-model', requestId: 'r1', output: { actions: [] } }
      },
    },
    contextRetriever: { async retrieveForUnderstandingDelta() { return context() } },
    repository: {
      async persistDerived() {},
      async persistDelta(input) {
        persisted = input
        return {
          deltaBatchId: 'd1', actionCount: 0, playerBriefId: 'brief-37', playerBriefVersion: 37,
          playerBriefChanged: false, source: 'persisted',
        }
      },
    },
  }

  const result = await derivePlayerUnderstandingDelta(deps, {
    playerId: 'p1', knowledgeEntryIds: ['k1'], date: '2026-08-18', batchKey: 'understanding-delta.v1:test',
  })

  assert.deepEqual(result.actions, [])
  assert.equal(result.persistence.playerBriefChanged, false)
  assert.equal(persisted.context.playerBrief.version, 37)
  assert.equal(request.context.playerBrief.version, 37)
  assert.match(request.instructions, /conversation history is not memory/i)
  assert.match(request.instructions, /actions: \[\]/)
})

test('understanding delta rejects target ids outside the current Player Brief', () => {
  assert.throws(() => validateUnderstandingDelta({
    actions: [{
      action: 'update',
      targetUnderstandingId: 'u-outside',
      type: 'priority',
      summary: 'Focus Japan',
      details: {},
      confidence: 0.9,
      importance: 5,
      sourceKnowledgeEntryIds: ['k1'],
      reason: 'New interview changes the priority.',
    }],
  }, new Set(['k1']), new Set(['u1'])), /outside current Player Brief/)
})

test('understanding delta validates create/update/resolve/supersede semantics', () => {
  const actions = validateUnderstandingDelta({
    actions: [
      {
        action: 'create', type: 'event', summary: 'Interview tomorrow at 10', details: {}, confidence: 1,
        importance: 5, sourceKnowledgeEntryIds: ['k1'], reason: 'New dated event.',
      },
      {
        action: 'resolve', targetUnderstandingId: 'u1', sourceKnowledgeEntryIds: ['k1'],
        reason: 'The prior priority is explicitly no longer current.',
      },
    ],
  }, new Set(['k1']), new Set(['u1']))

  assert.equal(actions.length, 2)
  assert.equal(actions[0].action, 'create')
  assert.equal(actions[1].action, 'resolve')
})

test('consumer prompt constrains targetUnderstandingId to Player Brief ids', () => {
  const prompt = buildConsumerChatPrompt({
    operation: 'derive_understanding_delta',
    schemaVersion: 'understanding-delta.v1',
    instructions: 'Return a bounded delta.',
    context: context(),
    responseContract: { type: 'object', required: ['actions'] },
  }, 'req-1')

  assert.match(prompt, /targetUnderstandingId may only use an id present in CONTEXT_DATA\.playerBrief\.activeUnderstandingIds/)
})

test('database migration defines versioned briefs, delta idempotency, and transition lineage', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/add_player_brief_memory.sql'), 'utf8')
  assert.match(sql, /create table if not exists public\.player_briefs/i)
  assert.match(sql, /unique \(user_id, batch_key\)/i)
  assert.match(sql, /create table if not exists public\.understanding_transitions/i)
  assert.match(sql, /create or replace function public\.persist_understanding_delta/i)
  assert.match(sql, /if v_action_count > 0 then[\s\S]*refresh_player_brief_internal/i)
})
