/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  QUEST_CANDIDATE_MIN,
  QUEST_CANDIDATE_ACCEPT_MIN,
  validateQuestIntelligenceDecision,
  compactQuestIntelligenceDecision,
} = require('../.domain-test-dist/lib/quest-intelligence-policy.js')

const SIGNAL_IDS = new Set(['s-goal', 's-blocker'])
const MAP = {
  id: 'map-1', version: 1, schemaVersion: 'progression-map.v1', reason: 'test', generatedAt: '2026-08-23T00:00:00Z', createdAt: '2026-08-23T00:00:00Z',
  goals: [{ nodeId: 'g1', summary: 'Improve finances', priority: 5, confidence: 0.9, sourceSignalIds: ['s-goal'] }],
  proximalOutcomes: [{ nodeId: 'o1', goalId: 'g1', summary: 'Choose one monetizable developer direction', importance: 5, confidence: 0.8, sourceSignalIds: ['s-goal'] }],
  bottlenecks: [{ nodeId: 'b1', outcomeIds: ['o1'], summary: 'Too many competing directions', importance: 5, confidence: 0.9, sourceSignalIds: ['s-blocker'] }],
  opportunities: [], uncertainties: [],
}
const TARGET = {
  id: 't1', userId: 'p1', targetDate: '2026-08-23', progressionMapId: 'map-1', dailyContextId: 'dc1', schemaVersion: 'progression-target.v1', createdAt: '2026-08-23T00:00:00Z',
  mode: 'progress', summary: 'Narrow the developer direction', primaryGoalId: 'g1', proximalOutcomeIds: ['o1'], bottleneckIds: ['b1'], opportunityIds: [], maxQuestCount: 2, rationale: 'Remove direction ambiguity.',
}

function candidate(index, category = 'sepanjang_hari') {
  return {
    candidateId: `c${index}`,
    title: `Action ${index}`,
    category,
    difficulty: 'easy',
    sourceSignalIds: ['s-goal', 's-blocker'],
    strategicChain: { goalId: 'g1', proximalOutcomeId: 'o1', driverType: 'bottleneck', driverId: 'b1', causalReason: 'Reduces direction ambiguity.' },
    feasibility: { feasibleToday: true, receptivity: 'high', estimatedMinutes: 20, reason: 'Fits today.' },
    executionContract: { action: `Do action ${index}`, completionCondition: `Action ${index} completed`, appropriateContext: 'One focused block', dose: '20 minutes' },
  }
}

function decisionWith(count, firstCategory = 'sepanjang_hari') {
  const candidates = Array.from({ length: count }, (_, i) => candidate(i + 1, i === 0 ? firstCategory : 'sepanjang_hari'))
  return { candidates, selections: [{ candidateId: 'c1', kind: 'main', selectionReason: 'Best leverage.' }] }
}

test('quest policy v3 keeps 8 candidates as the requested quality target but accepts a bounded 4-candidate degraded pool', () => {
  assert.equal(QUEST_CANDIDATE_MIN, 8)
  assert.equal(QUEST_CANDIDATE_ACCEPT_MIN, 4)
  const parsed = validateQuestIntelligenceDecision(decisionWith(4), SIGNAL_IDS, { progressionMap: MAP, progressionTarget: TARGET })
  assert.equal(parsed.candidates.length, 4)
  assert.equal(parsed.quests.length, 1)
  const compact = compactQuestIntelligenceDecision(parsed)
  assert.equal(compact.degradedCandidatePool, true)
  assert.equal(compact.requestedCandidateMin, 8)
  assert.throws(() => validateQuestIntelligenceDecision(decisionWith(3), SIGNAL_IDS, { progressionMap: MAP, progressionTarget: TARGET }), /at least 4 usable candidates/)
})

test('quest policy safely canonicalizes obvious time-of-day aliases but still rejects ambiguous categories', () => {
  const cases = [
    ['morning', 'pagi'],
    ['afternoon', 'siang'],
    ['evening', 'malam'],
    ['all day', 'sepanjang_hari'],
  ]
  for (const [input, expected] of cases) {
    const parsed = validateQuestIntelligenceDecision(decisionWith(4, input), SIGNAL_IDS, { progressionMap: MAP, progressionTarget: TARGET })
    assert.equal(parsed.candidates[0].category, expected)
  }
  assert.throws(() => validateQuestIntelligenceDecision(decisionWith(4, 'weekend'), SIGNAL_IDS, { progressionMap: MAP, progressionTarget: TARGET }), /invalid category/)
})

test('deterministic model-output failures are terminal and user retry cannot reopen them', () => {
  const migration = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/guard_deterministic_progression_failures.sql'), 'utf8')
  assert.match(migration, /if p_error_code = 'model_output_invalid' then/)
  assert.match(migration, /set status = 'failed'/)
  assert.match(migration, /v_existing\.status='failed' and v_existing\.error_code='model_output_invalid'/)
  assert.match(migration, /return v_existing;/)
})

test('progression target stage is idempotent before any provider call', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/ai/progression-intelligence-core.ts'), 'utf8')
  const functionStart = source.indexOf('export async function chooseProgressionTarget')
  const providerStart = source.indexOf('const provider = requireProvider', functionStart)
  const existingCheck = source.indexOf('loadProgressionTargetForDate', functionStart)
  const existingReturn = source.indexOf('if (existing) return existing', functionStart)
  assert.ok(functionStart >= 0)
  assert.ok(existingCheck > functionStart && existingCheck < providerStart)
  assert.ok(existingReturn > existingCheck && existingReturn < providerStart)
})
