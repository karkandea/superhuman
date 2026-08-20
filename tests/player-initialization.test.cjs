/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  validateInitializationCalibrationDecision,
} = require('../.domain-test-dist/lib/player-initialization.js')

function dimensions(status = 'sufficient') {
  return {
    direction: { status, confidence: status === 'sufficient' ? 0.9 : 0.4, summary: 'Evidence-based assessment.' },
    current_state: { status, confidence: status === 'sufficient' ? 0.9 : 0.4, summary: 'Evidence-based assessment.' },
    bottleneck_opportunity: { status, confidence: status === 'sufficient' ? 0.9 : 0.4, summary: 'Evidence-based assessment.' },
    capacity_constraints: { status, confidence: status === 'sufficient' ? 0.9 : 0.4, summary: 'Evidence-based assessment.' },
  }
}

test('READY requires all four decision-readiness dimensions and no follow-up questions', () => {
  const decision = validateInitializationCalibrationDecision({
    readiness: 'ready',
    reason: 'Enough evidence exists for a meaningful progression decision.',
    dimensions: dimensions(),
    questions: [],
  })
  assert.equal(decision.readiness, 'ready')
  assert.throws(() => validateInitializationCalibrationDecision({
    readiness: 'ready',
    reason: 'Still missing direction.',
    dimensions: { ...dimensions(), direction: { status: 'uncertain', confidence: 0.4, summary: 'Direction is unresolved.' } },
    questions: [],
  }), /insufficient dimensions/)
  assert.throws(() => validateInitializationCalibrationDecision({
    readiness: 'ready',
    reason: 'Should not ask after ready.',
    dimensions: dimensions(),
    questions: [{ questionKey: 'x', dimension: 'direction', prompt: 'What matters?', reason: 'Resolve direction.', priority: 5, sequence: 0 }],
  }), /cannot include follow-up/)
})

test('ASK requires a bounded, canonical and uniquely keyed question batch', () => {
  const decision = validateInitializationCalibrationDecision({
    readiness: 'ask',
    reason: 'Capacity is still uncertain.',
    dimensions: { ...dimensions(), capacity_constraints: { status: 'uncertain', confidence: 0.45, summary: 'Available time is unclear.' } },
    questions: [
      { questionKey: 'weekly_capacity', dimension: 'capacity_constraints', prompt: 'Dalam minggu biasa, waktu yang realistis bisa lo sisihkan buat fokus ini kapan?', reason: 'The next decision needs a realistic capacity bound.', priority: 5, sequence: 0 },
    ],
  })
  assert.equal(decision.questions.length, 1)
  assert.throws(() => validateInitializationCalibrationDecision({
    readiness: 'ask', reason: 'Missing info.', dimensions: dimensions('uncertain'), questions: [],
  }), /requires at least one useful follow-up/)
  assert.throws(() => validateInitializationCalibrationDecision({
    readiness: 'ask', reason: 'Missing info.', dimensions: dimensions('uncertain'), questions: [
      { questionKey: 'duplicate', dimension: 'direction', prompt: 'One?', reason: 'Reason one.', priority: 5, sequence: 0 },
      { questionKey: 'duplicate', dimension: 'current_state', prompt: 'Two?', reason: 'Reason two.', priority: 4, sequence: 1 },
    ],
  }), /must be unique/)
  assert.throws(() => validateInitializationCalibrationDecision({
    readiness: 'ask', reason: 'Missing info.', dimensions: dimensions('uncertain'), questions: [
      { questionKey: 'invalid', dimension: 'height', prompt: 'How tall are you?', reason: 'Random profile completion.', priority: 3, sequence: 0 },
    ],
  }), /canonical initialization dimension/)
})

test('database policy keeps raw evidence WAIT and blocks date-rollover reasoning', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/add_player_initialization_readiness.sql'), 'utf8')
  assert.match(sql, /drop trigger if exists knowledge_entries_enqueue_progression/i)
  assert.match(sql, /create or replace function public\.enqueue_daily_progression_cycles\(\)[\s\S]*?return 0;/i)
  assert.match(sql, /request_initialization_calibration/i)
  assert.match(sql, /'decisionPoint','initialization_calibration'/i)
  assert.match(sql, /Answer at least one initialization question with new evidence before calibration/i)
  assert.match(sql, /Player Initialization is not READY; Daily Quest decision is blocked/i)
  assert.match(sql, /grant execute on function public\.persist_player_initialization_calibration_internal[\s\S]*?to service_role/i)
})

test('new player initialization bootstraps an empty canonical Player Brief before any AI call', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/bootstrap_player_brief_before_initialization.sql'), 'utf8')
  assert.match(sql, /ensure_player_brief_bootstrap_internal/i)
  assert.match(sql, /'player_initialization_bootstrap'/i)
  assert.match(sql, /'activeUnderstandingIds','\[\]'::jsonb/i)
  assert.match(sql, /'activeSignals','\[\]'::jsonb/i)
  assert.match(sql, /perform public\.ensure_player_brief_bootstrap_internal\(v_user_id\)/i)
  assert.match(sql, /revoke all on function public\.ensure_player_brief_bootstrap_internal\(uuid\) from public, anon, authenticated/i)
  assert.match(sql, /grant execute on function public\.ensure_player_brief_bootstrap_internal\(uuid\) to service_role/i)
})
