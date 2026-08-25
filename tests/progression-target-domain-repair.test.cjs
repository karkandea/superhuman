const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const repair = fs.readFileSync('lib/ai/progression-target-domain-repair.ts', 'utf8')
const barrel = fs.readFileSync('lib/ai/progression-intelligence.ts', 'utf8')

test('progression target uses a dedicated validator-repair provider', () => {
  assert.match(barrel, /chooseProgressionTarget.*progression-target-domain-repair/)
  assert.match(repair, /request\.operation !== 'choose_progression_move'/)
  assert.match(repair, /validateProgressionMoveDecision/)
  assert.match(repair, /new ProgressionTargetRepairProvider\(dependencies\.provider\)/)
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

test('repair stays inside the same structured operation so existing envelope repair and System voice still apply', () => {
  assert.match(repair, /const repairRequest: StructuredModelRequest = \{[\s\S]*\.\.\.request/)
  assert.doesNotMatch(repair, /operation:\s*'repair_/)
  assert.match(repair, /await this\.delegate\.invokeStructured\(repairRequest\)/)
})
