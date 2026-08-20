/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8')
}

test('worker-facing TypeScript wrappers expose runtime names explicitly across package boundaries', () => {
  const progression = source('lib/ai/progression-intelligence.ts')
  const orchestrator = source('lib/ai/orchestrator.ts')

  for (const name of [
    'chooseProgressionTarget',
    'loadQuestGenerationIntelligence',
    'refreshPlayerResponseModel',
    'reviewQuestResponses',
  ]) {
    assert.match(
      progression,
      new RegExp(`export[\\s\\S]*?\\b${name}\\b[\\s\\S]*?from './progression-intelligence-core'`),
      `${name} must be an explicit runtime re-export; export * is not safe through the root CommonJS package boundary`,
    )
  }
  assert.match(progression, /export \{ refreshProgressionMap \} from '\.\/player-initialization-progression'/)

  for (const name of [
    'derivePlayerUnderstanding',
    'generateDailyQuests',
    'assessKnowledgeMateriality',
    'generateSystemInterrupt',
  ]) {
    assert.match(
      orchestrator,
      new RegExp(`export[\\s\\S]*?\\b${name}\\b[\\s\\S]*?from './orchestrator-core'`),
      `${name} must be an explicit runtime re-export; export * is not safe through the root CommonJS package boundary`,
    )
  }
  assert.match(orchestrator, /export \{ derivePlayerUnderstandingDelta \} from '\.\/player-initialization-orchestrator'/)
})
