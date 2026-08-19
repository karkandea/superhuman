/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const { validateQuestPolicyDecision } = require('../.domain-test-dist/lib/quest-policy.js')

function candidate(index) {
  return {
    candidateId: `c${index}`,
    title: `Candidate ${index}`,
    category: 'sepanjang_hari',
    difficulty: 'easy',
    xp: 10,
    rationale: 'Evidence-backed option',
    sourceSignalIds: ['s1'],
    scores: {
      goalRelevance: 3,
      urgency: 3,
      leverage: 3,
      obstacleRemoval: 2,
      actionability: 5,
      contextFit: 5,
      progressionValue: 2,
      redundancyPenalty: 0,
    },
  }
}

test('very low-capacity day may select one focused Main Quest without filler', () => {
  const decision = validateQuestPolicyDecision({
    candidates: Array.from({ length: 8 }, (_, index) => candidate(index + 1)),
    selections: [{
      candidateId: 'c1',
      kind: 'main',
      priority: 5,
      selectionReason: 'Capacity is very low; one safe action deserves full attention.',
    }],
  }, new Set(['s1']))

  assert.equal(decision.quests.length, 1)
  assert.equal(decision.quests[0].kind, 'main')
})
