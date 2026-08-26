export const WORKER_QA_FIXTURE_VERSION = 'worker-qa.v1'

const SIGNAL_IDS = ['qa-signal-career', 'qa-signal-capacity']
const KNOWLEDGE_IDS = ['qa-knowledge-1', 'qa-knowledge-2']

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function arrayOfStrings(value) {
  return Array.isArray(value) && value.every(nonEmptyString)
}

function provenanceErrors(ids, allowed, field) {
  if (!arrayOfStrings(ids) || ids.length === 0) return [`${field} must be a non-empty string array`]
  const invalid = ids.filter(id => !allowed.includes(id))
  return invalid.length ? [`${field} contains invalid ids: ${invalid.join(',')}`] : []
}

function progressionTargetValidator(output) {
  const errors = []
  if (!isObject(output)) return ['output must be an object']
  if (!nonEmptyString(output.targetId)) errors.push('targetId is required')
  if (!nonEmptyString(output.objective)) errors.push('objective is required')
  if (!nonEmptyString(output.rationale)) errors.push('rationale is required')
  errors.push(...provenanceErrors(output.sourceSignalIds, SIGNAL_IDS, 'sourceSignalIds'))
  return errors
}

function questValidator(output) {
  const errors = []
  if (!isObject(output)) return ['output must be an object']
  if (!Array.isArray(output.quests) || output.quests.length < 1 || output.quests.length > 2) {
    return ['quests must contain 1-2 items']
  }
  output.quests.forEach((quest, index) => {
    if (!isObject(quest)) {
      errors.push(`quests[${index}] must be an object`)
      return
    }
    if (!nonEmptyString(quest.title)) errors.push(`quests[${index}].title is required`)
    if (!nonEmptyString(quest.action)) errors.push(`quests[${index}].action is required`)
    if (!Number.isInteger(quest.durationMinutes) || quest.durationMinutes < 10 || quest.durationMinutes > 120) {
      errors.push(`quests[${index}].durationMinutes must be an integer from 10-120`)
    }
    errors.push(...provenanceErrors(quest.sourceSignalIds, SIGNAL_IDS, `quests[${index}].sourceSignalIds`))
  })
  return errors
}

function searchValidator(output) {
  const errors = []
  if (!isObject(output)) return ['output must be an object']
  if (!nonEmptyString(output.summary)) errors.push('summary is required')
  if (!Array.isArray(output.sources) || output.sources.length < 2) {
    errors.push('sources must contain at least two sources')
  } else {
    output.sources.forEach((source, index) => {
      if (!isObject(source) || !nonEmptyString(source.url) || !/^https?:\/\//i.test(source.url)) {
        errors.push(`sources[${index}].url must be an http(s) URL`)
      }
      if (!isObject(source) || !nonEmptyString(source.title)) errors.push(`sources[${index}].title is required`)
    })
  }
  return errors
}

function understandingValidator(output) {
  const errors = []
  if (!isObject(output)) return ['output must be an object']
  if (!nonEmptyString(output.summary)) errors.push('summary is required')
  errors.push(...provenanceErrors(output.sourceKnowledgeEntryIds, KNOWLEDGE_IDS, 'sourceKnowledgeEntryIds'))
  return errors
}

function mapValidator(output) {
  const errors = []
  if (!isObject(output)) return ['output must be an object']
  if (!nonEmptyString(output.mapSummary)) errors.push('mapSummary is required')
  errors.push(...provenanceErrors(output.sourceSignalIds, SIGNAL_IDS, 'sourceSignalIds'))
  return errors
}

function composerStressValidator(output) {
  const errors = []
  if (!isObject(output)) return ['output must be an object']
  if (output.acknowledgedToken !== 'QA_COMPOSER_STRESS_V1') errors.push('acknowledgedToken mismatch')
  if (!nonEmptyString(output.summary)) errors.push('summary is required')
  return errors
}

const baseSignals = [
  {
    id: 'qa-signal-career',
    type: 'career',
    summary: 'Synthetic player is preparing for a backend software engineering interview in two weeks.',
    importance: 0.9,
  },
  {
    id: 'qa-signal-capacity',
    type: 'capacity',
    summary: 'Synthetic player has 60-90 minutes available today.',
    importance: 0.8,
  },
]

function progressionTargetRequest(extraContext = {}) {
  return {
    operation: 'choose_progression_target',
    schemaVersion: 'worker-qa.progression-target.v1',
    instructions: [
      'Choose one coherent short-term progression target for the synthetic player.',
      'Use only the supplied context. Do not invent personal facts.',
      'The target should be actionable within the next two weeks.',
    ].join(' '),
    context: {
      date: '2026-01-15',
      signals: baseSignals,
      playerBrief: {
        activeUnderstandingIds: ['qa-understanding-career'],
        summary: 'Synthetic QA fixture: backend engineer preparing for an interview.',
      },
      progressionMap: {
        version: 1,
        focus: 'Improve interview readiness through deliberate backend practice.',
      },
      ...extraContext,
    },
    responseContract: {
      targetId: 'string stable id for the chosen target',
      objective: 'concise target objective',
      rationale: 'brief rationale',
      sourceSignalIds: ['one or more ids copied from CONTEXT_DATA.signals'],
    },
  }
}

function questRequest(extraContext = {}) {
  return {
    operation: 'generate_daily_quests',
    schemaVersion: 'worker-qa.quest-generation.v1',
    instructions: [
      'Generate a minimal executable daily quest portfolio for the synthetic player.',
      'Return one or two quests only. Respect available capacity and supplied progression target.',
      'Do not invent player facts.',
    ].join(' '),
    context: {
      date: '2026-01-15',
      signals: baseSignals,
      dailyContext: { mode: 'normal', availableMinutes: 75 },
      progressionTarget: {
        targetId: 'qa-target-interview-readiness',
        objective: 'Increase backend interview readiness before the interview date.',
      },
      ...extraContext,
    },
    responseContract: {
      quests: [{
        title: 'short title',
        action: 'specific executable action',
        durationMinutes: 'integer from 10 to 120',
        sourceSignalIds: ['one or more ids copied from CONTEXT_DATA.signals'],
      }],
    },
  }
}

function searchRequest() {
  return {
    operation: 'research_progression_context',
    schemaVersion: 'worker-qa.search.v1',
    instructions: [
      'Use external web search for this request. Do not answer from memory alone.',
      'Research stable, public guidance for effective backend software engineering interview preparation.',
      'Return a concise synthesis and at least two source URLs.',
      'This is a synthetic QA fixture; do not search for or infer any player identity.',
    ].join(' '),
    context: {
      date: '2026-01-15',
      researchTopic: 'backend software engineering interview preparation',
    },
    responseContract: {
      summary: 'concise research synthesis',
      sources: [{ title: 'source title', url: 'https://...' }],
    },
  }
}

function understandingRequest() {
  return {
    operation: 'derive_understanding_delta',
    schemaVersion: 'worker-qa.understanding.v1',
    instructions: 'Summarize the synthetic evidence into one bounded understanding. Preserve knowledge provenance exactly.',
    context: {
      date: '2026-01-15',
      knowledgeEntries: [
        { id: 'qa-knowledge-1', rawText: 'I have a backend engineering interview in two weeks.' },
        { id: 'qa-knowledge-2', rawText: 'I can practice for around one hour today.' },
      ],
      playerBrief: { activeUnderstandingIds: [] },
    },
    responseContract: {
      summary: 'bounded understanding summary',
      sourceKnowledgeEntryIds: ['ids copied from CONTEXT_DATA.knowledgeEntries'],
    },
  }
}

function mapRequest(previousUnderstanding) {
  return {
    operation: 'derive_progression_map',
    schemaVersion: 'worker-qa.progression-map.v1',
    instructions: 'Create a concise progression map for the synthetic player using only supplied evidence.',
    context: {
      date: '2026-01-15',
      signals: baseSignals,
      syntheticUnderstanding: previousUnderstanding,
    },
    responseContract: {
      mapSummary: 'concise progression map summary',
      sourceSignalIds: ['one or more ids copied from CONTEXT_DATA.signals'],
    },
  }
}

function composerStressRequest() {
  const stressPayload = Array.from({ length: 1200 }, (_, index) => `QA_BLOCK_${String(index).padStart(4, '0')}: synthetic bounded browser composer stress data.`).join('\n')
  return {
    operation: 'derive_understanding',
    schemaVersion: 'worker-qa.composer-stress.v1',
    instructions: [
      'This is a browser composer reliability test.',
      'Read the bounded synthetic payload and return the exact acknowledgedToken plus a one-sentence summary.',
    ].join(' '),
    context: {
      date: '2026-01-15',
      qaToken: 'QA_COMPOSER_STRESS_V1',
      stressPayload,
    },
    responseContract: {
      acknowledgedToken: 'must equal QA_COMPOSER_STRESS_V1',
      summary: 'one short sentence',
    },
  }
}

async function runSingle(runStep, name, request, validator) {
  await runStep({ name, request, validator })
}

export function getWorkerQaScenario(name) {
  if (name === 'progression_target_normal') {
    return {
      name,
      async run(runStep) {
        await runSingle(runStep, 'progression_target', progressionTargetRequest(), progressionTargetValidator)
      },
    }
  }

  if (name === 'quest_generation_normal') {
    return {
      name,
      async run(runStep) {
        await runSingle(runStep, 'quest_generation', questRequest(), questValidator)
      },
    }
  }

  if (name === 'search') {
    return {
      name,
      async run(runStep) {
        await runSingle(runStep, 'search', searchRequest(), searchValidator)
      },
    }
  }

  if (name === 'composer_recovery') {
    return {
      name,
      async run(runStep) {
        await runSingle(runStep, 'composer_stress', composerStressRequest(), composerStressValidator)
      },
    }
  }

  if (name === 'full_chain_normal') {
    return {
      name,
      async run(runStep) {
        const understanding = await runStep({
          name: 'understanding',
          request: understandingRequest(),
          validator: understandingValidator,
        })
        const map = await runStep({
          name: 'progression_map',
          request: mapRequest(understanding),
          validator: mapValidator,
        })
        const target = await runStep({
          name: 'progression_target',
          request: progressionTargetRequest({ syntheticMapOutput: map }),
          validator: progressionTargetValidator,
        })
        await runStep({
          name: 'quest_generation',
          request: questRequest({ syntheticTargetOutput: target }),
          validator: questValidator,
        })
      },
    }
  }

  throw new Error(`Unsupported Worker QA scenario: ${name}`)
}

export const WORKER_QA_SCENARIOS = [
  'progression_target_normal',
  'quest_generation_normal',
  'search',
  'composer_recovery',
  'full_chain_normal',
]
