const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const sql = fs.readFileSync('supabase/sql/add_operator_progression_requeue.sql', 'utf8')

test('operator requeue is service-role-only and one-shot', () => {
  assert.match(sql, /auth\.role\(\)/)
  assert.match(sql, /service_role/)
  assert.match(sql, /revoke all on function public\.operator_requeue_progression_job\(uuid,text\)[\s\S]*public, anon, authenticated/)
  assert.match(sql, /grant execute on function public\.operator_requeue_progression_job\(uuid,text\)[\s\S]*service_role/)
  assert.match(sql, /operatorRequeueCount/)
  assert.match(sql, /v_operator_requeue_count >= 1/)
})

test('operator requeue only resumes a failed unfinished progression job', () => {
  assert.match(sql, /v_job\.operation <> 'progression_cycle'/)
  assert.match(sql, /v_job\.status <> 'failed'/)
  assert.match(sql, /public\.quest_batches/)
  assert.match(sql, /b\.status = 'generated'/)
  assert.match(sql, /status = 'queued'/)
  assert.match(sql, /attempt_count = 0/)
  assert.match(sql, /correlation_id = gen_random_uuid\(\)/)
})

test('operator requeue preserves prior recovery summary and durable steps', () => {
  assert.match(sql, /result_summary = coalesce\(result_summary, '\{\}'::jsonb\) \|\| jsonb_build_object/)
  assert.doesNotMatch(sql, /result_summary\s*=\s*'\{\}'::jsonb/)
  assert.doesNotMatch(sql, /delete\s+from\s+public\.progression_run_steps/i)
  assert.doesNotMatch(sql, /truncate\s+public\.progression_run_steps/i)
})
