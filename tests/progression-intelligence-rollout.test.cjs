/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function read(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8')
}

test('migration creates four-layer intelligence persistence and owner-scoped RLS', () => {
  const sql = read('supabase/sql/add_progression_intelligence.sql')
  for (const table of ['progression_maps', 'player_response_models', 'progression_targets', 'quest_response_events']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`))
  }
  assert.match(sql, /enable row level security/)
  assert.match(sql, /auth\.uid\(\)/)
})

test('learning sync is idempotent and no-quest reason is explicit', () => {
  const sql = read('supabase/sql/add_progression_intelligence.sql')
  assert.match(sql, /unique.*quest_id.*outcome/i)
  assert.match(sql, /no_quest_reason/i)
})

test('quest result capture separates compliance storage from effectiveness learning', () => {
  const sql = read('supabase/sql/add_progression_intelligence.sql')
  assert.match(sql, /record_daily_quest_result/)
  assert.match(sql, /quest_response_events/)
})

test('worker runs response learning and strategic target before new quest generation', () => {
  const worker = read('workers/chatgpt-consumer/worker-v2.mjs')
  const syncAt = worker.indexOf('syncQuestResponseEvents')
  const reviewAt = worker.indexOf('reviewQuestResponses')
  const responseModelAt = worker.indexOf('refreshPlayerResponseModel')
  const targetAt = worker.indexOf('chooseProgressionTarget')
  const generationAt = worker.indexOf('generateDailyQuestsWithIntelligence')
  assert.ok(syncAt >= 0)
  assert.ok(reviewAt > syncAt)
  assert.ok(responseModelAt > reviewAt)
  assert.ok(targetAt > responseModelAt)
  assert.ok(generationAt > targetAt)
  assert.match(worker, /hasFinalizedPlanForDate/)
  assert.match(worker, /source: 'no_quest'/)
  assert.match(worker, /noQuest: generated\.source === 'no_quest'/)
  assert.doesNotMatch(worker, /generateDailyQuests\(/)
})

test('Today recognizes a finalized zero-quest plan and keeps causal execution details useful', () => {
  const page = read('app/[username]/page.tsx')
  assert.match(page, /dailyPlanReady = questReady \|\| Boolean\(dailyPlan\?\.finalized\)/)
  assert.match(page, /SYSTEM DECISION/)
  assert.match(page, /No quest needed right now\./)
  assert.match(page, /SYSTEM FOCUS/)
  assert.match(page, /WHY ·/)
  assert.match(page, /DONE WHEN ·/)
  assert.match(page, /DOSE ·/)
  assert.match(page, /record_daily_quest_result/)
  assert.match(page, /\(\['partial', 'skipped', 'failed'\] as const\)/)
  assert.match(page, /outcome\.toUpperCase\(\)/)
  assert.doesNotMatch(page, /No Daily Quest was persisted for today\./)
})
