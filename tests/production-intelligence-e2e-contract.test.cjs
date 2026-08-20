/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const progressionWrapper = fs.readFileSync('lib/ai/player-initialization-progression.ts', 'utf8')
const migration = fs.readFileSync('supabase/sql/harden_production_intelligence_e2e.sql', 'utf8')

test('Progression Map waits for response review instead of reasoning twice around the same new outcome', () => {
  assert.match(progressionWrapper, /loadQuestResponseEvents\(input\.playerId/)
  assert.match(progressionWrapper, /hasPendingResponseLearning = responseEvents\.some\(event => !event\.reviewedAt\)/)
  assert.match(progressionWrapper, /if \(hasPendingResponseLearning\) return existing/)
  assert.ok(
    progressionWrapper.indexOf('if (hasPendingResponseLearning) return existing') <
      progressionWrapper.indexOf('return refreshCoreProgressionMap(dependencies, input)'),
    'pending response learning must short-circuit before the provider-backed map refresh',
  )
})

test('production worker has the minimum initialization read grants it actually uses', () => {
  assert.match(migration, /grant select on table public\.player_initializations to service_role;/)
  assert.match(migration, /grant select on table public\.player_initialization_questions to service_role;/)
  assert.doesNotMatch(migration, /grant (insert|update|delete|all).*player_initializations.*service_role/i)
  assert.doesNotMatch(migration, /grant (insert|update|delete|all).*player_initialization_questions.*service_role/i)
})

test('quest-result requeue clears stale execution metadata when no worker currently owns the job', () => {
  for (const functionName of ['record_daily_quest_result', 'set_daily_quest_completion']) {
    const start = migration.indexOf(`create or replace function public.${functionName}`)
    assert.notEqual(start, -1, `${functionName} must be hardened`)
    const next = migration.indexOf('create or replace function public.', start + 1)
    const body = migration.slice(start, next === -1 ? migration.length : next)

    assert.match(body, /started_at=case when public\.ai_inference_jobs\.status='running' then public\.ai_inference_jobs\.started_at else null end/)
    assert.match(body, /lease_expires_at=case when public\.ai_inference_jobs\.status='running' then public\.ai_inference_jobs\.lease_expires_at else null end/)
    assert.match(body, /worker_id=case when public\.ai_inference_jobs\.status='running' then public\.ai_inference_jobs\.worker_id else null end/)
    assert.match(body, /provider_id=case when public\.ai_inference_jobs\.status='running' then public\.ai_inference_jobs\.provider_id else null end/)
    assert.match(body, /provider_conversation_refs=case when public\.ai_inference_jobs\.status='running' then public\.ai_inference_jobs\.provider_conversation_refs else '\[\]'::jsonb end/)
    assert.match(body, /result_summary=case when public\.ai_inference_jobs\.status='running' then public\.ai_inference_jobs\.result_summary else '\{\}'::jsonb end/)
    assert.match(body, /window_cutoff_at=case when public\.ai_inference_jobs\.status='running' then public\.ai_inference_jobs\.window_cutoff_at else null end/)
  }
})
