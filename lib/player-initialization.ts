export const INITIALIZATION_DIMENSIONS = [
  'direction',
  'current_state',
  'bottleneck_opportunity',
  'capacity_constraints',
] as const

export type InitializationDimension = typeof INITIALIZATION_DIMENSIONS[number]
export type InitializationReadiness = 'ask' | 'ready'
export type InitializationStage = 'initializing' | 'calibrating' | 'ready'
export type InitializationQuestionOrigin = 'basic' | 'adaptive'
export type InitializationQuestionStatus = 'pending' | 'answered' | 'skipped' | 'superseded'

export interface InitializationDimensionAssessment {
  status: 'missing' | 'uncertain' | 'sufficient'
  confidence: number
  summary: string
}

export type InitializationDimensions = Record<InitializationDimension, InitializationDimensionAssessment>

export interface InitializationQuestionCandidate {
  questionKey: string
  dimension: InitializationDimension
  prompt: string
  reason: string
  priority: 1 | 2 | 3 | 4 | 5
  sequence: number
}

export interface InitializationCalibrationDecision {
  readiness: InitializationReadiness
  reason: string
  dimensions: InitializationDimensions
  questions: InitializationQuestionCandidate[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max = 2000): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  const normalized = value.trim()
  if (normalized.length > max) throw new Error(`${label} is too long`)
  return normalized
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const number = boundedNumber(value, label, minimum, maximum)
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`)
  return number
}

function dimension(value: unknown, label: string): InitializationDimension {
  if (!INITIALIZATION_DIMENSIONS.includes(value as InitializationDimension)) {
    throw new Error(`${label} is not a canonical initialization dimension`)
  }
  return value as InitializationDimension
}

function assessment(value: unknown, key: InitializationDimension): InitializationDimensionAssessment {
  const item = record(value, `Initialization dimension ${key}`)
  const status = item.status
  if (status !== 'missing' && status !== 'uncertain' && status !== 'sufficient') {
    throw new Error(`Initialization dimension ${key} has invalid status`)
  }
  return {
    status,
    confidence: boundedNumber(item.confidence, `Initialization dimension ${key} confidence`, 0, 1),
    summary: text(item.summary, `Initialization dimension ${key} summary`, 800),
  }
}

export function validateInitializationCalibrationDecision(value: unknown): InitializationCalibrationDecision {
  const root = record(value, 'Initialization calibration decision')
  if (root.readiness !== 'ask' && root.readiness !== 'ready') {
    throw new Error('Initialization readiness must be ASK or READY')
  }

  const rawDimensions = record(root.dimensions, 'Initialization dimensions')
  const dimensions = Object.fromEntries(
    INITIALIZATION_DIMENSIONS.map(key => [key, assessment(rawDimensions[key], key)]),
  ) as InitializationDimensions

  if (!Array.isArray(root.questions)) throw new Error('Initialization questions must be an array')
  if (root.questions.length > 5) throw new Error('Initialization calibration may propose at most five questions')

  const keys = new Set<string>()
  const questions = root.questions.map((raw, index): InitializationQuestionCandidate => {
    const item = record(raw, `Initialization question ${index}`)
    const questionKey = text(item.questionKey, `Initialization question ${index} key`, 120)
    if (keys.has(questionKey)) throw new Error('Initialization question keys must be unique within one calibration')
    keys.add(questionKey)

    return {
      questionKey,
      dimension: dimension(item.dimension, `Initialization question ${index} dimension`),
      prompt: text(item.prompt, `Initialization question ${index} prompt`, 1000),
      reason: text(item.reason, `Initialization question ${index} reason`, 1000),
      priority: boundedInteger(item.priority, `Initialization question ${index} priority`, 1, 5) as 1 | 2 | 3 | 4 | 5,
      sequence: boundedInteger(item.sequence, `Initialization question ${index} sequence`, 0, 100),
    }
  })

  if (root.readiness === 'ready') {
    if (questions.length > 0) throw new Error('READY initialization cannot include follow-up questions')
    const insufficient = INITIALIZATION_DIMENSIONS.filter(key => dimensions[key].status !== 'sufficient')
    if (insufficient.length > 0) throw new Error(`READY initialization still has insufficient dimensions: ${insufficient.join(', ')}`)
  } else if (questions.length === 0) {
    throw new Error('ASK initialization requires at least one useful follow-up question')
  }

  return {
    readiness: root.readiness,
    reason: text(root.reason, 'Initialization readiness reason', 2000),
    dimensions,
    questions,
  }
}
