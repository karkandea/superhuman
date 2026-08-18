/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  materialityDisposition,
  validateMaterialityAssessment,
  validateQuestInterruptPlan,
} = require('../.domain-test-dist/lib/materiality.js')
const {
  assessKnowledgeMateriality,
  generateSystemInterrupt,
} = require('../.domain-test-dist/lib/ai/orchestrator.js')
const { BoundedPlayerContextRetriever } = require('../.domain-test-dist/lib/context-retrieval.js')

function playerBrief() {
  return {
    id: 'brief-1', version: 1, schemaVersion: 'player-brief.v1', reason: 'test',
    createdAt: '2026-08-18T10:00:00Z', generatedAt: '2026-08-18T10:00:00Z',
    player: { id: 'p1', name: 'Player', timezone: 'Asia/Jakarta' },
    activeUnderstandingIds: [], highlights: [],
    sections: { goals: [], obstacles: [], opportunities: [], constraints: [], preferences: [], relationships: [], events: [], priorities: [] },
    activeSignals: [], counts: { activeUnderstanding: 0, activeSignals: 1 },
  }
}

function assessment(overrides = {}) {
  return {
    isMaterial: false,
    level: 'low',
    confidence: 0.8,
    reason: 'No same-day priority change.',
    affectedQuestIds: [],
    sourceSignalIds: [],
    recommendedAction: 'none',
    urgency: 'none',
    ...overrides,
  }
}

function persistedAssessment(overrides = {}) {
  const value = assessment(overrides)
  return {
    id: 'a1',
    userId: 'p1',
    knowledgeEntryId: 'k1',
    targetDate: '2026-08-18',
    disposition: materialityDisposition(value),
    createdAt: '2026-08-18T10:00:00Z',
    ...value,
  }
}

test('Scenario A — mild mood update is non-material and leaves today stable', () => {
  const decision = validateMaterialityAssessment(
    assessment({ reason: 'Mood is mildly worse but no current action or deadline changes.' }),
    new Set(['q-backend']),
    new Set(['s-mood']),
  )
  assert.equal(decision.isMaterial, false)
  assert.equal(materialityDisposition(decision), 'no_change')
  assert.equal(decision.recommendedAction, 'none')
})

test('Scenario B — interview moved to today becomes high-confidence auto interrupt', () => {
  const decision = validateMaterialityAssessment({
    isMaterial: true,
    level: 'high',
    confidence: 0.94,
    reason: 'The interview moved to 16:00 today, displacing lower-priority work.',
    affectedQuestIds: ['q-portfolio'],
    sourceSignalIds: ['s-interview'],
    recommendedAction: 'defer',
    urgency: 'immediate',
  }, new Set(['q-portfolio']), new Set(['s-interview']))

  assert.equal(materialityDisposition(decision), 'auto_interrupt')

  const plan = validateQuestInterruptPlan({
    summary: 'Interview prep becomes today’s immediate priority.',
    actions: [
      { action: 'defer', targetQuestId: 'q-portfolio', reason: 'Portfolio remains valid but should move after the interview.' },
      {
        action: 'add',
        reason: 'Prepare before the newly moved interview.',
        quest: {
          title: '60-minute interview preparation',
          category: 'siang',
          kind: 'main',
          difficulty: 'medium',
          priority: 1,
          xp: 100,
          rationale: 'The interview now happens at 16:00 today.',
          sourceSignalIds: ['s-interview'],
        },
      },
    ],
  }, new Set(['q-portfolio']), new Set(['s-interview']))

  assert.equal(plan.actions.length, 2)
  assert.equal(plan.actions[0].action, 'defer')
  assert.equal(plan.actions[1].action, 'add')
})

test('Scenario C — 39C fever can replace workout with recovery-compatible action', () => {
  const decision = validateMaterialityAssessment({
    isMaterial: true,
    level: 'critical',
    confidence: 0.97,
    reason: 'A 39°C fever makes the planned run inappropriate today.',
    affectedQuestIds: ['q-run'],
    sourceSignalIds: ['s-fever'],
    recommendedAction: 'replace',
    urgency: 'immediate',
  }, new Set(['q-run']), new Set(['s-fever']))
  assert.equal(materialityDisposition(decision), 'auto_interrupt')

  const plan = validateQuestInterruptPlan({
    summary: 'Recovery replaces strenuous exercise.',
    actions: [{
      action: 'replace',
      targetQuestId: 'q-run',
      reason: 'Strenuous exercise conflicts with the acute health condition.',
      quest: {
        title: 'Rest, hydrate, and monitor fever',
        category: 'sepanjang_hari',
        kind: 'main',
        difficulty: 'easy',
        priority: 1,
        xp: 60,
        rationale: 'Recovery is the safe immediate action given the fever.',
        sourceSignalIds: ['s-fever'],
      },
    }],
  }, new Set(['q-run']), new Set(['s-fever']))
  assert.equal(plan.actions[0].action, 'replace')
})

test('Scenario D — long-term Japan aspiration does not reshuffle today by itself', () => {
  const decision = validateMaterialityAssessment(assessment({
    confidence: 0.92,
    reason: 'Moving to Japan next year is useful long-term context but has no immediate deadline or same-day action.',
  }), new Set(['q-current']), new Set(['s-japan']))
  assert.equal(materialityDisposition(decision), 'no_change')
})

test('Scenario E — duplicate materiality processing reuses persisted assessment without provider call', async () => {
  let providerCalls = 0
  const existing = persistedAssessment({
    isMaterial: true,
    level: 'high',
    confidence: 0.92,
    reason: 'Same-day deadline changed.',
    affectedQuestIds: ['q1'],
    sourceSignalIds: ['s1'],
    recommendedAction: 'reprioritize',
    urgency: 'today',
  })
  const result = await assessKnowledgeMateriality({
    provider: { id: 'test', async invokeStructured() { providerCalls += 1; throw new Error('provider must not run') } },
    contextRetriever: { async retrieveForMateriality() { throw new Error('retrieval must not run') } },
    repository: {
      async findAssessment() { return existing },
      async persistAssessment() { throw new Error('persist must not run') },
      async findInterruptForAssessment() { return null },
      async persistInterrupt() { throw new Error('persist interrupt must not run') },
    },
  }, { playerId: 'p1', knowledgeEntryId: 'k1', date: '2026-08-18' })

  assert.equal(result.source, 'existing')
  assert.equal(result.assessment.id, 'a1')
  assert.equal(providerCalls, 0)
})

test('Scenario E — duplicate interrupt processing reuses persisted interrupt without provider call', async () => {
  let providerCalls = 0
  const currentAssessment = persistedAssessment({
    isMaterial: true,
    level: 'high',
    confidence: 0.92,
    reason: 'Same-day deadline changed.',
    affectedQuestIds: ['q1'],
    sourceSignalIds: ['s1'],
    recommendedAction: 'defer',
    urgency: 'today',
  })
  const existingInterrupt = {
    id: 'i1', userId: 'p1', assessmentId: 'a1', questDate: '2026-08-18', status: 'applied',
    summary: 'Already applied', createdAt: '2026-08-18T10:01:00Z', appliedAt: '2026-08-18T10:01:01Z',
  }
  const result = await generateSystemInterrupt({
    provider: { id: 'test', async invokeStructured() { providerCalls += 1; throw new Error('provider must not run') } },
    contextRetriever: { async retrieveForSystemInterrupt() { throw new Error('retrieval must not run') } },
    repository: {
      async findAssessment() { return currentAssessment },
      async persistAssessment() { throw new Error('not used') },
      async findInterruptForAssessment() { return existingInterrupt },
      async persistInterrupt() { throw new Error('persist must not run') },
    },
  }, { playerId: 'p1', knowledgeEntryId: 'k1', date: '2026-08-18', assessment: currentAssessment })

  assert.equal(result.source, 'existing')
  assert.equal(result.interrupt.id, 'i1')
  assert.equal(providerCalls, 0)
})

test('Scenario F — completed quest cannot be retroactively targeted', () => {
  assert.throws(() => validateMaterialityAssessment({
    isMaterial: true,
    level: 'high',
    confidence: 0.95,
    reason: 'Priority changed.',
    affectedQuestIds: ['q-completed'],
    sourceSignalIds: ['s1'],
    recommendedAction: 'replace',
    urgency: 'today',
  }, new Set(['q-active']), new Set(['s1'])), /outside active context/)

  assert.throws(() => validateQuestInterruptPlan({
    summary: 'Attempt to rewrite completed history',
    actions: [{ action: 'defer', targetQuestId: 'q-completed', reason: 'Should be rejected.' }],
  }, new Set(['q-active']), new Set(['s1'])), /active quest/)
})

test('materiality context uses bounded trigger knowledge, canonical Player Brief, and player local time', async () => {
  const retriever = new BoundedPlayerContextRetriever({
    async loadKnowledgeEntries(_playerId, ids) { return ids.map(id => ({ id, type: 'life_update', text: 'Interview moved to 16:00 today.' })) },
    async loadSignals() { return [{ id: 's1', userId: 'p1', type: 'event', summary: 'Interview today', importance: 5, confidence: 0.95, observedAt: '2026-08-18T09:00:00Z' }] },
    async loadRecentQuestResults() { return [] },
    async loadActiveQuests() { return [{ id: 'q1', title: 'Portfolio', category: 'siang', kind: 'main', difficulty: 'medium', priority: 1, xp: 100, rationale: 'existing', status: 'pending', source: 'ai' }] },
    async loadPlayerTimezone() { return 'Asia/Jakarta' },
    async loadCurrentPlayerBrief() { return playerBrief() },
  })

  const context = await retriever.retrieveForMateriality({
    playerId: 'p1', knowledgeEntryId: 'k1', date: '2026-08-18', limit: 8,
    now: new Date('2026-08-18T10:00:00Z'),
  })
  assert.equal(context.playerTimezone, 'Asia/Jakarta')
  assert.equal(context.localDateTime, '2026-08-18T17:00:00')
  assert.equal(context.playerBrief.id, 'brief-1')
  assert.equal(context.triggerKnowledgeEntry.id, 'k1')
  assert.deepEqual(context.activeQuests.map(q => q.id), ['q1'])
})