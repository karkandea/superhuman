/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_FILE_UPDATE_BYTES,
  composeKnowledgeText,
  deriveSystemFreshness,
  validateKnowledgeFileDescriptor,
} = require('../.domain-test-dist/lib/system-ux.js')

test('System update upload accepts only bounded TXT, MD and JSON files', () => {
  for (const name of ['update.txt', 'notes.MD', 'context.json']) {
    const validated = validateKnowledgeFileDescriptor({ name, size: 1024 })
    assert.equal(validated.name, name)
  }

  const boundary = validateKnowledgeFileDescriptor({ name: 'boundary.txt', size: MAX_KNOWLEDGE_FILE_BYTES })
  assert.equal(boundary.size, MAX_KNOWLEDGE_FILE_BYTES)

  assert.throws(
    () => validateKnowledgeFileDescriptor({ name: 'resume.pdf', size: 1024 }),
    /Only TXT, MD, and JSON files are supported/,
  )
  assert.throws(
    () => validateKnowledgeFileDescriptor({ name: 'huge.txt', size: MAX_KNOWLEDGE_FILE_BYTES + 1 }),
    /20 KB or smaller/,
  )
  assert.throws(
    () => validateKnowledgeFileDescriptor({ name: 'empty.md', size: 0 }),
    /file is empty/,
  )
})

test('System update composer merges optional message and text file into one knowledge entry', () => {
  assert.equal(
    composeKnowledgeText('This changed today.', 'file line one\nfile line two', 'context.md'),
    'This changed today.\n\nAttached file — context.md\n\nfile line one\nfile line two',
  )
  assert.equal(composeKnowledgeText('', 'only file text', 'notes.txt'), 'only file text')
  assert.throws(() => composeKnowledgeText('   '), /Tell the System something or attach a file/)
  assert.throws(() => composeKnowledgeText('x'.repeat(50_001)), /too large/)
})

test('text plus attachment stays below the bounded reasoning payload budget', () => {
  assert.equal(MAX_KNOWLEDGE_FILE_UPDATE_BYTES, 22 * 1024)
  assert.throws(
    () => composeKnowledgeText('caption '.repeat(500), 'x'.repeat(20 * 1024), 'context.txt'),
    /note plus attached file under 22 KB total/,
  )
  assert.doesNotThrow(() => composeKnowledgeText('short note', 'x'.repeat(18 * 1024), 'context.txt'))
})

test('queued progression is presented as collecting updates', () => {
  const view = deriveSystemFreshness({
    latestKnowledgeCreatedAt: '2026-08-19T07:00:00Z',
    latestKnowledgeProcessingStatus: 'pending',
    latestKnowledgeMaterialityStatus: 'pending',
    latestJobStatus: 'queued',
    latestJobUpdatedAt: '2026-08-19T07:00:02Z',
  })

  assert.equal(view.phase, 'collecting')
  assert.equal(view.isBusy, true)
  assert.match(view.title, /safe/i)
})

test('running progression is presented as System understanding processing', () => {
  const view = deriveSystemFreshness({
    latestKnowledgeCreatedAt: '2026-08-19T07:00:00Z',
    latestKnowledgeProcessingStatus: 'processing',
    latestKnowledgeMaterialityStatus: 'pending',
    latestJobStatus: 'running',
    latestJobUpdatedAt: '2026-08-19T07:01:00Z',
  })

  assert.equal(view.phase, 'processing')
  assert.equal(view.isBusy, true)
  assert.match(view.title, /updating its understanding/i)
})

test('temporary processing failure tells the player the update is safe and can retry', () => {
  const view = deriveSystemFreshness({
    latestKnowledgeCreatedAt: '2026-08-19T07:00:00Z',
    latestKnowledgeProcessingStatus: 'failed',
    latestKnowledgeMaterialityStatus: 'pending',
    latestJobStatus: 'failed',
    latestJobUpdatedAt: '2026-08-19T07:01:00Z',
    latestJobErrorCode: 'provider_rate_limited',
  })

  assert.equal(view.phase, 'failure')
  assert.equal(view.canRetry, true)
  assert.match(view.title, /safe/i)
  assert.doesNotMatch(view.detail, /add.*context/i)
})

test('understood non-material update explicitly preserves today quests', () => {
  const view = deriveSystemFreshness({
    latestKnowledgeCreatedAt: '2026-08-19T07:00:00Z',
    latestKnowledgeProcessingStatus: 'processed',
    latestKnowledgeMaterialityStatus: 'assessed',
    latestAssessmentDisposition: 'no_change',
    latestJobStatus: 'succeeded',
    latestJobUpdatedAt: '2026-08-19T07:02:00Z',
    latestJobCompletedAt: '2026-08-19T07:02:00Z',
  })

  assert.equal(view.phase, 'no_change')
  assert.match(view.eyebrow, /QUESTS UNCHANGED/)
})

test('material update is presented as explicit System Interrupt', () => {
  const view = deriveSystemFreshness({
    latestKnowledgeCreatedAt: '2026-08-19T07:00:00Z',
    latestKnowledgeProcessingStatus: 'processed',
    latestKnowledgeMaterialityStatus: 'assessed',
    latestAssessmentDisposition: 'auto_interrupt',
    latestInterruptStatus: 'applied',
    latestJobStatus: 'succeeded',
    latestJobUpdatedAt: '2026-08-19T07:02:00Z',
    latestJobCompletedAt: '2026-08-19T07:02:00Z',
  })

  assert.equal(view.phase, 'interrupt')
  assert.match(view.title, /changed today/i)
})

test('stale succeeded job cannot make a newer saved update look processed', () => {
  const view = deriveSystemFreshness({
    latestKnowledgeCreatedAt: '2026-08-19T07:10:00Z',
    latestKnowledgeProcessingStatus: 'pending',
    latestKnowledgeMaterialityStatus: 'pending',
    latestJobStatus: 'succeeded',
    latestJobUpdatedAt: '2026-08-19T07:00:00Z',
    latestJobCompletedAt: '2026-08-19T07:00:00Z',
    currentBriefCreatedAt: '2026-08-19T06:55:00Z',
  })

  assert.equal(view.phase, 'saved')
  assert.match(view.title, /safe/i)
})
