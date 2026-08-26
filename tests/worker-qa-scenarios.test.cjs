/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

async function moduleUnderTest() {
  return import('../workers/chatgpt-consumer/qa-scenarios.mjs')
}

function validOutputFor(operation) {
  if (operation === 'derive_understanding_delta') {
    return {
      summary: 'Synthetic player has a near-term backend interview and bounded practice capacity.',
      sourceKnowledgeEntryIds: ['qa-knowledge-1', 'qa-knowledge-2'],
    }
  }
  if (operation === 'derive_progression_map') {
    return {
      mapSummary: 'Prioritize deliberate backend interview practice.',
      sourceSignalIds: ['qa-signal-career'],
    }
  }
  if (operation === 'choose_progression_target') {
    return {
      targetId: 'qa-target-interview-readiness',
      objective: 'Increase backend interview readiness within two weeks.',
      rationale: 'The interview is near-term and decision relevant.',
      sourceSignalIds: ['qa-signal-career', 'qa-signal-capacity'],
    }
  }
  if (operation === 'generate_daily_quests') {
    return {
      quests: [{
        title: 'Backend interview drill',
        action: 'Complete one timed backend interview problem and review mistakes.',
        durationMinutes: 60,
        sourceSignalIds: ['qa-signal-career', 'qa-signal-capacity'],
      }],
    }
  }
  if (operation === 'research_progression_context') {
    return {
      summary: 'Use targeted practice plus review of mistakes.',
      sources: [
        { title: 'Source A', url: 'https://example.com/a' },
        { title: 'Source B', url: 'https://example.com/b' },
      ],
    }
  }
  if (operation === 'derive_understanding') {
    return {
      acknowledgedToken: 'QA_COMPOSER_STRESS_V1',
      summary: 'Synthetic composer payload was received intact.',
    }
  }
  throw new Error(`No fake output for ${operation}`)
}

test('all Worker QA scenarios execute against a fake step runner with no live AI', async () => {
  const { WORKER_QA_SCENARIOS, getWorkerQaScenario } = await moduleUnderTest()

  for (const name of WORKER_QA_SCENARIOS) {
    const seen = []
    const scenario = getWorkerQaScenario(name)
    await scenario.run(async spec => {
      seen.push(spec.name)
      const output = validOutputFor(spec.request.operation)
      assert.deepEqual(spec.validator(output), [], `${name}/${spec.name} should accept valid fixture output`)
      return output
    })
    assert.ok(seen.length >= 1, `${name} should execute at least one step`)
  }
})

test('full chain executes understanding -> map -> target -> quest in order', async () => {
  const { getWorkerQaScenario } = await moduleUnderTest()
  const seen = []

  await getWorkerQaScenario('full_chain_normal').run(async spec => {
    seen.push(spec.name)
    return validOutputFor(spec.request.operation)
  })

  assert.deepEqual(seen, [
    'understanding',
    'progression_map',
    'progression_target',
    'quest_generation',
  ])
})

test('scenario validators reject invented provenance and malformed results', async () => {
  const { getWorkerQaScenario } = await moduleUnderTest()
  let targetValidator
  let questValidator

  await getWorkerQaScenario('progression_target_normal').run(async spec => {
    targetValidator = spec.validator
    return validOutputFor(spec.request.operation)
  })
  await getWorkerQaScenario('quest_generation_normal').run(async spec => {
    questValidator = spec.validator
    return validOutputFor(spec.request.operation)
  })

  assert.ok(targetValidator({
    targetId: 'x',
    objective: 'x',
    rationale: 'x',
    sourceSignalIds: ['invented-signal'],
  }).length > 0)

  assert.ok(questValidator({
    quests: [{
      title: 'x',
      action: 'x',
      durationMinutes: 999,
      sourceSignalIds: ['invented-signal'],
    }],
  }).length > 0)
})
