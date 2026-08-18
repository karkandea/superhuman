/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MATERIALITY_BATCH_SCHEMA_VERSION,
  materialityBatchKey,
  selectKnowledgeBatchByBytes,
  utf8ByteLength,
} = require('../.domain-test-dist/lib/activity-orchestration.js')

test('knowledge batching is budget-based instead of entry-count based', () => {
  const rows = [
    { id: 'k1', raw_text: 'a'.repeat(400) },
    { id: 'k2', raw_text: 'b'.repeat(400) },
    { id: 'k3', raw_text: 'c'.repeat(400) },
  ]

  const batch = selectKnowledgeBatchByBytes(rows, 1400, 100)
  assert.deepEqual(batch.ids, ['k1', 'k2'])
  assert.equal(batch.estimatedBytes, 1000)
})

test('one oversized knowledge entry still makes progress as a single batch', () => {
  const rows = [
    { id: 'huge', raw_text: 'x'.repeat(5000) },
    { id: 'later', raw_text: 'small' },
  ]

  const batch = selectKnowledgeBatchByBytes(rows, 1024, 100)
  assert.deepEqual(batch.ids, ['huge'])
  assert.ok(batch.estimatedBytes > 1024)
})

test('UTF-8 byte accounting handles multibyte text', () => {
  assert.equal(utf8ByteLength('abc'), 3)
  assert.ok(utf8ByteLength('🔥') > 1)
})

test('materiality batch idempotency key is stable for the same activity set', () => {
  const first = materialityBatchKey('2026-08-18', ['k3', 'k1', 'k2'])
  const second = materialityBatchKey('2026-08-18', ['k2', 'k3', 'k1', 'k1'])
  assert.equal(first, second)
  assert.match(first, new RegExp(`^${MATERIALITY_BATCH_SCHEMA_VERSION}:2026-08-18:`))
})
