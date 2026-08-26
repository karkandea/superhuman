/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

const migration = source('supabase/sql/enable_autonomous_daily_progression.sql')
const dailyContextService = source('lib/daily-context-service.ts')
const worker = source('workers/chatgpt-consumer/worker-v2.mjs')
const composer = source('app/[username]/update-system-composer.tsx')
const layout = source('app/[username]/layout.tsx')


test('System owns the normal daily default instead of requiring player acknowledgement', () => {
  assert.match(migration, /create or replace function public\.ensure_daily_progression_operator/)
  assert.match(migration, /insert into public\.daily_contexts\(user_id,context_date,mode,context_text\)/)
  assert.match(migration, /values\(p_user_id,p_target_date,'normal',''\)/)
  assert.match(migration, /on conflict\(user_id,context_date\) do nothing/)
  assert.match(migration, /grant execute on function public\.ensure_daily_progression\(date\) to authenticated/)
  assert.match(migration, /perform public\.ensure_daily_progression\(p_target_date\)/)
})


test('background cron starts a ready player day after the 04:00 local boundary', () => {
  assert.match(migration, /create or replace function public\.enqueue_daily_progression_cycles\(\)/)
  assert.match(migration, /pi\.readiness='ready'/)
  assert.match(migration, /v_local_now := now\(\) at time zone v_timezone/)
  assert.match(migration, /v_local_now::time < time '04:00'/)
  assert.match(migration, /ensure_daily_progression_operator\(v_player\.id,v_local_now::date\)/)
  assert.doesNotMatch(migration, /enqueue_daily_progression_cycles[\s\S]{0,300}return 0;/)
})


test('autonomous ensure is idempotent and never turns failed jobs into an endless retry loop', () => {
  assert.match(migration, /on conflict\(user_id,operation,target_date\) do nothing/)
  assert.match(migration, /v_job\.status='succeeded'/)
  assert.match(migration, /result_summary->>'awaitingDailyContext'/)
  assert.match(migration, /autoDailyResumedAt/)
  assert.doesNotMatch(migration, /v_job\.status='failed'[\s\S]{0,250}status='queued'/)
  assert.doesNotMatch(migration, /v_job\.status in \([^)]*'failed'/)
})


test('Today Daily Context read self-heals before selecting context so the old check-in card is not a gate', () => {
  const ensureIndex = dailyContextService.indexOf("client.rpc('ensure_daily_progression'")
  const selectIndex = dailyContextService.indexOf(".from('daily_contexts')")
  assert.ok(ensureIndex >= 0, 'Today context service must call the safe autonomous ensure RPC')
  assert.ok(selectIndex > ensureIndex, 'Daily Context must be ensured before it is selected')
  assert.match(dailyContextService, /p_target_date: targetDate/)
})


test('sticky Today update remains the correction path and triggers materiality-based quest reevaluation', () => {
  assert.match(layout, /showComposer = pathname === todayPath \|\| pathname === vaultPath/)
  assert.match(layout, /Ada yang perlu System tahu hari ini\?/)
  assert.match(composer, /ingestManualKnowledge/)
  assert.match(composer, /entryType: file \? 'note' : 'life_update'/)
  assert.match(composer, /superhuman:knowledge-saved/)
  assert.match(worker, /if \(hadDailyPlan\)/)
  assert.match(worker, /pendingMaterialityKnowledgeIds/)
  assert.match(worker, /assessActivityMateriality/)
  assert.match(worker, /generateSystemInterrupt/)
  assert.match(worker, /generatedInterrupt\.interrupt\.status === 'applied'/)
})


test('autonomy does not replace the whole day when context changes', () => {
  assert.doesNotMatch(migration, /delete from public\.daily_quests/i)
  assert.doesNotMatch(migration, /update public\.daily_quests/i)
  assert.match(worker, /affectedQuestIds/)
  assert.match(worker, /generateSystemInterrupt/)
})
