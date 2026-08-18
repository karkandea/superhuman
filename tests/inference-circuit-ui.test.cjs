/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const { getAiInferenceJob } = require('../.domain-test-dist/lib/ai/inference-job-service.js')

function singleRowClient(row) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: row, error: null }),
              }
            },
          }
        },
      }
    },
  }
}

test('paused provider circuit is exposed to existing UI as recoverable transport interruption', async () => {
  const client = singleRowClient({
    id: 'job-1',
    user_id: 'player-1',
    operation: 'progression_cycle',
    target_date: '2026-08-18',
    status: 'paused_rate_limit',
    attempt_count: 1,
    max_attempts: 3,
    error_code: 'provider_rate_limited',
    error_message: 'provider paused',
    created_at: '2026-08-18T10:00:00Z',
    updated_at: '2026-08-18T10:05:00Z',
  })

  const job = await getAiInferenceJob(client, 'job-1')
  assert.equal(job.status, 'failed')
  assert.equal(job.errorCode, 'provider_rate_limited')
  assert.equal(job.errorMessage, 'provider paused')
})
