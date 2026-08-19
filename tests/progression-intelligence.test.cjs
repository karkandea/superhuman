const test = require('node:test')
const assert = require('node:assert/strict')

const {
  validateProgressionMap,
  validateProgressionTarget,
  validateQuestResponseReviews,
  validatePlayerResponseModel,
} = require('../.domain-test-dist/lib/progression-intelligence.js')
const {
  validateQuestIntelligenceDecision,
} = require('../.domain-test-dist/lib/quest-intelligence-policy.js')
const {
  generateDailyQuestsWithIntelligence,
} = require('../.domain-test-dist/lib/ai/daily-quest-intelligence.js')

const SIGNALS = [
  { id: 's-goal', userId: 'p1', type: 'goal', summary: 'Get an overseas software role', importance: 5, confidence: 0.95, observedAt: '2026-08-19T00:00:00Z' },
  { id: 's-bottleneck', userId: 'p1', type: 'obstacle', summary: 'Application execution is low', importance: 5, confidence: 0.85, observedAt: '2026-08-19T00:00:00Z' },
  { id: 's-opportunity', userId: 'p1', type: 'opportunity', summary: 'Recruiter is waiting for a reply', importance: 5, confidence: 0.9, observedAt: '2026-08-19T00:00:00Z' },
]

const MAP_BODY = {
  goals: [{ nodeId: 'g-role', summary: 'Get an overseas software role', priority: 5, confidence: 0.95, sourceSignalIds: ['s-goal'] }],
  proximalOutcomes: [{ nodeId: 'o-interview', goalId: 'g-role', summary: 'Start receiving qualified interviews', importance: 5, confidence: 0.8, sourceSignalIds: ['s-goal', 's-bottleneck'] }],
  bottlenecks: [{ nodeId: 'b-app', outcomeIds: ['o-interview'], summary: 'Application execution is too low to test conversion', importance: 5, confidence: 0.82, sourceSignalIds: ['s-bottleneck'] }],
  opportunities: [{ nodeId: 'opp-recruiter', outcomeIds: ['o-interview'], summary: 'Recruiter response can unlock an interview path', importance: 5, confidence: 0.9, sourceSignalIds: ['s-opportunity'] }],
  uncertainties: ['CV conversion rate is not yet established.'],
}

const MAP = {
  id: 'map-1', version: 1, schemaVersion: 'progression-map.v1', reason: 'test', generatedAt: '2026-08-19T00:00:00Z', createdAt: '2026-08-19T00:00:00Z',
  ...MAP_BODY,
}

const TARGET = {
  id: 'target-1', userId: 'p1', targetDate: '2026-08-19', progressionMapId: 'map-1', dailyContextId: 'dc-1', schemaVersion: 'progression-target.v1', createdAt: '2026-08-19T00:00:00Z',
  mode: 'progress', summary: 'Unlock the recruiter opportunity', primaryGoalId: 'g-role', proximalOutcomeIds: ['o-interview'], bottleneckIds: ['b-app'], opportunityIds: ['opp-recruiter'], maxQuestCount: 2, rationale: 'High leverage and time-sensitive.',
}

function candidate(index, overrides = {}) {
  return {
    candidateId: `c${index}`,
    title: `Candidate action ${index}`,
    category: 'sepanjang_hari',
    difficulty: 'easy',
    xp: 50,
    rationale: 'Evidence-backed option.',
    sourceSignalIds: ['s-goal', index === 1 ? 's-opportunity' : 's-bottleneck'],
    strategicChain: index === 1
      ? { goalId: 'g-role', proximalOutcomeId: 'o-interview', driverType: 'opportunity', driverId: 'opp-recruiter', causalReason: 'Replying moves the live recruiter opportunity toward an interview.' }
      : { goalId: 'g-role', proximalOutcomeId: 'o-interview', driverType: 'bottleneck', driverId: 'b-app', causalReason: 'This action reduces the application execution bottleneck.' },
    feasibility: { feasibleToday: true, receptivity: 'high', estimatedMinutes: 20, reason: 'Fits the available context.' },
    executionContract: { action: `Do action ${index}`, completionCondition: `Action ${index} is submitted or sent`, appropriateContext: 'During one focused block today', dose: 'One bounded action' },
    scores: { goalRelevance: 5, urgency: 4, leverage: 4, obstacleRemoval: 4, actionability: 5, contextFit: 5, progressionValue: 4, redundancyPenalty: 0 },
    ...overrides,
  }
}

function candidates() {
  return Array.from({ length: 8 }, (_, index) => candidate(index + 1))
}

const PLAYER_BRIEF = {
  id: 'brief-1', version: 1, schemaVersion: 'player-brief.v1', reason: 'test', createdAt: '2026-08-19T00:00:00Z', generatedAt: '2026-08-19T00:00:00Z',
  player: { id: 'p1', name: 'QA', timezone: 'Asia/Jakarta' }, activeUnderstandingIds: [], highlights: [],
  sections: { goals: [], obstacles: [], opportunities: [], constraints: [], preferences: [], relationships: [], events: [], priorities: [] },
  activeSignals: [], counts: { activeUnderstanding: 0, activeSignals: 3 },
}

const BASE_CONTEXT = {
  playerId: 'p1', purpose: 'daily_quest', generatedAt: '2026-08-19T00:00:00Z', playerBrief: PLAYER_BRIEF,
  dailyContext: { id: 'dc-1', userId: 'p1', contextDate: '2026-08-19', mode: 'context', text: 'Only 30 minutes tonight.', createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z' },
  knowledgeEntries: [], signals: SIGNALS, recentQuestResults: [], retrieval: { strategy: 'test', limit: 32, reason: 'test' },
}

test('Progression Map validates causal graph and bounded provenance', () => {
  assert.deepEqual(validateProgressionMap(MAP_BODY, new Set(SIGNALS.map(signal => signal.id))), MAP_BODY)
  assert.throws(() => validateProgressionMap({ ...MAP_BODY, proximalOutcomes: [{ ...MAP_BODY.proximalOutcomes[0], goalId: 'missing' }] }, new Set(SIGNALS.map(signal => signal.id))), /unknown goal/)
  assert.throws(() => validateProgressionMap({ ...MAP_BODY, bottlenecks: [{ ...MAP_BODY.bottlenecks[0], sourceSignalIds: ['other-player-signal'] }] }, new Set(SIGNALS.map(signal => signal.id))), /outside bounded context/)
})

test('effectiveness cannot be inferred from completion without downstream signal evidence', () => {
  assert.deepEqual(validateQuestResponseReviews([{ questId: 'q1', effectiveness: 'unknown', effectivenessReason: 'The action completed, but downstream outcome movement is not yet observed.', evidenceSignalIds: [], confidence: 0.8 }], new Set(['q1']), new Set(SIGNALS.map(signal => signal.id)))[0].effectiveness, 'unknown')
  assert.throws(() => validateQuestResponseReviews([{ questId: 'q1', effectiveness: 'strong', effectivenessReason: 'Completed.', evidenceSignalIds: [], confidence: 0.9 }], new Set(['q1']), new Set(SIGNALS.map(signal => signal.id))), /cannot claim effectiveness without downstream signal evidence/)
})

test('Player Response Model may only learn from bounded quest evidence', () => {
  const model = {
    executionPatterns: [{ patternId: 'p1', observation: 'Smaller application batches appear easier to execute.', confidence: 0.6, evidenceQuestIds: ['q1'], preferredAdjustment: 'Keep the next batch small and specific.' }],
    difficultyCalibration: [], receptivityPatterns: [], strategyEvidence: [], uncertainties: ['Evidence is still sparse.'],
  }
  assert.deepEqual(validatePlayerResponseModel(model, new Set(['q1'])), model)
  assert.throws(() => validatePlayerResponseModel({ ...model, executionPatterns: [{ ...model.executionPatterns[0], evidenceQuestIds: ['q-other'] }] }, new Set(['q1'])), /outside bounded context/)
})

test('Progression Target supports explicit no-intervention and rejects incoherent progress targets', () => {
  const noIntervention = validateProgressionTarget({ mode: 'no_intervention', summary: 'Do not add burden today.', proximalOutcomeIds: [], bottleneckIds: [], opportunityIds: [], maxQuestCount: 0, rationale: 'Capacity is exhausted.', noQuestReason: 'Recovery is the higher-value choice.' }, MAP)
  assert.equal(noIntervention.maxQuestCount, 0)
  assert.throws(() => validateProgressionTarget({ mode: 'progress', summary: 'Move career', primaryGoalId: 'g-role', proximalOutcomeIds: ['o-interview'], bottleneckIds: [], opportunityIds: [], maxQuestCount: 2, rationale: 'No driver.' }, MAP), /requires a bottleneck or opportunity/)
})

test('Quest Policy V2 enforces causal chain, feasibility gate, executable contract and portfolio ceiling', () => {
  const valid = validateQuestIntelligenceDecision({ candidates: candidates(), selections: [{ candidateId: 'c1', kind: 'main', priority: 5, selectionReason: 'Best current leverage.' }] }, new Set(SIGNALS.map(signal => signal.id)), { progressionMap: MAP, progressionTarget: TARGET })
  assert.equal(valid.quests.length, 1)
  assert.equal(valid.quests[0].strategicChain.proximalOutcomeId, 'o-interview')
  assert.equal(valid.quests[0].executionContract.dose, 'One bounded action')

  const infeasible = candidates()
  infeasible[0] = candidate(1, { feasibility: { feasibleToday: false, receptivity: 'low', estimatedMinutes: 90, reason: 'Does not fit today.' } })
  assert.throws(() => validateQuestIntelligenceDecision({ candidates: infeasible, selections: [{ candidateId: 'c1', kind: 'main', priority: 5, selectionReason: 'Strategically strong.' }] }, new Set(SIGNALS.map(signal => signal.id)), { progressionMap: MAP, progressionTarget: TARGET }), /failed feasibility/)

  assert.throws(() => validateQuestIntelligenceDecision({ candidates: candidates(), selections: [{ candidateId: 'c1', kind: 'main', priority: 5, selectionReason: 'one' }, { candidateId: 'c2', kind: 'side', priority: 4, selectionReason: 'two' }, { candidateId: 'c3', kind: 'side', priority: 3, selectionReason: 'three' }] }, new Set(SIGNALS.map(signal => signal.id)), { progressionMap: MAP, progressionTarget: TARGET }), /exceeds Progression Target/)
})

test('Quest Policy V2 allows zero quests only with an explicit reason', () => {
  const decision = validateQuestIntelligenceDecision({ candidates: candidates(), selections: [], noQuestReason: 'All worthwhile options are unreceptive in today context.' }, new Set(SIGNALS.map(signal => signal.id)), { progressionMap: MAP, progressionTarget: TARGET })
  assert.equal(decision.quests.length, 0)
  assert.match(decision.noQuestReason, /unreceptive/)
  assert.throws(() => validateQuestIntelligenceDecision({ candidates: candidates(), selections: [] }, new Set(SIGNALS.map(signal => signal.id)), { progressionMap: MAP, progressionTarget: TARGET }), /requires noQuestReason/)
})

test('no-intervention target finalizes a zero-quest plan without invoking quest provider', async () => {
  let providerCalls = 0
  let persistedReason = null
  const noTarget = { ...TARGET, mode: 'no_intervention', primaryGoalId: undefined, proximalOutcomeIds: [], bottleneckIds: [], opportunityIds: [], maxQuestCount: 0, noQuestReason: 'No additional intervention is useful today.' }
  const progressionStore = {
    hasNoQuestPlanForDate: async () => false,
    loadCurrentProgressionMap: async () => MAP,
    loadCurrentPlayerResponseModel: async () => null,
    loadProgressionTargetForDate: async () => noTarget,
    loadQuestResponseEvents: async () => [],
    persistNoQuestPlan: async input => { persistedReason = input.noQuestReason },
  }
  const result = await generateDailyQuestsWithIntelligence({
    provider: { id: 'never', invokeStructured: async () => { providerCalls += 1; throw new Error('provider should not be called') } },
    contextRetriever: { retrieveForDailyQuest: async () => BASE_CONTEXT },
    repository: { findForDate: async () => [], persistGeneratedBatch: async () => { throw new Error('quest persistence should not run') } },
    progressionStore,
  }, { playerId: 'p1', date: '2026-08-19' })
  assert.equal(result.source, 'no_quest')
  assert.equal(providerCalls, 0)
  assert.equal(persistedReason, noTarget.noQuestReason)
})

test('policy-level zero selection also finalizes no-quest instead of becoming an empty-result error', async () => {
  let persistedReason = null
  const progressionStore = {
    hasNoQuestPlanForDate: async () => false,
    loadCurrentProgressionMap: async () => MAP,
    loadCurrentPlayerResponseModel: async () => null,
    loadProgressionTargetForDate: async () => TARGET,
    loadQuestResponseEvents: async () => [],
    persistNoQuestPlan: async input => { persistedReason = input.noQuestReason },
  }
  const result = await generateDailyQuestsWithIntelligence({
    provider: { id: 'model', invokeStructured: async () => ({ output: { candidates: candidates(), selections: [], noQuestReason: 'Every worthwhile option failed today feasibility gate.' }, providerId: 'model', modelId: 'm1', requestId: 'r1' }) },
    contextRetriever: { retrieveForDailyQuest: async () => BASE_CONTEXT },
    repository: { findForDate: async () => [], persistGeneratedBatch: async () => { throw new Error('quest persistence should not run') } },
    progressionStore,
  }, { playerId: 'p1', date: '2026-08-19' })
  assert.equal(result.source, 'no_quest')
  assert.match(persistedReason, /feasibility/)
})

test('selected quest persists causal/execution metadata after the existing quest batch write', async () => {
  let attached = null
  const progressionStore = {
    hasNoQuestPlanForDate: async () => false,
    loadCurrentProgressionMap: async () => MAP,
    loadCurrentPlayerResponseModel: async () => null,
    loadProgressionTargetForDate: async () => TARGET,
    loadQuestResponseEvents: async () => [],
    attachQuestMetadata: async input => { attached = input.items },
  }
  const result = await generateDailyQuestsWithIntelligence({
    provider: { id: 'model', invokeStructured: async () => ({ output: { candidates: candidates(), selections: [{ candidateId: 'c1', kind: 'main', priority: 5, selectionReason: 'Live recruiter opportunity.' }] }, providerId: 'model', modelId: 'm1', requestId: 'r1' }) },
    contextRetriever: { retrieveForDailyQuest: async () => BASE_CONTEXT },
    repository: {
      findForDate: async () => [],
      persistGeneratedBatch: async ({ candidates: selected }) => [{ id: 'q1', userId: 'p1', batchId: 'batch1', questDate: '2026-08-19', source: 'ai', status: 'pending', ...selected[0] }],
    },
    progressionStore,
  }, { playerId: 'p1', date: '2026-08-19' })
  assert.equal(result.source, 'generated')
  assert.equal(result.quests.length, 1)
  assert.equal(attached.length, 1)
  assert.equal(attached[0].candidateId, 'c1')
  assert.equal(attached[0].strategicChain.driverId, 'opp-recruiter')
  assert.match(attached[0].executionContract.completionCondition, /submitted or sent/)
})
