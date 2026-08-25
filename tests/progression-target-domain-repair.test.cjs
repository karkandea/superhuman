const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const repair = fs.readFileSync('lib/ai/progression-target-domain-repair.ts', 'utf8')
const barrel = fs.readFileSync('lib/ai/progression-intelligence.ts', 'utf8')
const conversation = fs.readFileSync('lib/ai/progression-conversation-intelligence.ts', 'utf8')

test('worker boundary still routes progression target through the bounded conversation gate', () => {
  assert.match(barrel, /export \{ chooseProgressionTarget \} from '\.\/progression-conversation-intelligence'/)
  assert.match(conversation, /chooseProgressionTargetCore/)
  assert.match(conversation, /withProgressionTargetDomainRepair\(dependencies\.provider\)/)
  assert.doesNotMatch(barrel, /chooseProgressionTarget.*progression-target-domain-repair/)
})

test('progression target validator repair is bounded to one attempt', () => {
  assert.match(repair, /private repairUsed = false/)
  assert.match(repair, /if \(this\.repairUsed\)/)
  assert.match(repair, /this\.repairUsed = true/)
  assert.match(repair, /Progression Target validator repair already used/)
  assert.match(repair, /Progression Target validator repair exhausted/)
  assert.doesNotMatch(repair, /while\s*\(/)
})

test('repair preserves decision intent and never bypasses validation', () => {
  assert.match(repair, /Keep the same strategic intent and nextAction/)
  assert.match(repair, /Do not invent IDs/)
  assert.match(repair, /previousOutput: initial\.output/)
  assert.match(repair, /validatorDiagnostic:/)
  assert.match(repair, /validateMoveForRequest\(request, repaired\.output\)/)
  assert.match(repair, /clarification budget is exhausted/)
  assert.ok(
    repair.indexOf('validateMoveForRequest(request, repaired.output)')
      < repair.indexOf("console.warn(`[progression-target-repair] succeeded"),
  )
})

test('repair context preserves the required progression date with a real typed shape', () => {
  assert.match(repair, /ProgressionConversationModelContext/)
  assert.match(repair, /function progressionMoveContext/)
  assert.match(repair, /choose_progression_move context is missing date/)
  assert.match(repair, /const repairContext: ProgressionConversationModelContext/)
  assert.match(repair, /date: context\.date/)
  assert.match(repair, /context: repairContext/)
  assert.doesNotMatch(repair, /as StructuredModelRequest\['context'\]/)
  assert.doesNotMatch(repair, /as unknown as/)
})

test('repair stays inside the same structured operation so existing envelope repair and System voice still apply', () => {
  assert.match(repair, /const repairRequest: StructuredModelRequest = \{[\s\S]*\.\.\.request/)
  assert.doesNotMatch(repair, /operation:\s*'repair_/)
  assert.match(repair, /await this\.delegate\.invokeStructured\(repairRequest\)/)
  assert.match(repair, /export function withProgressionTargetDomainRepair/)
})
