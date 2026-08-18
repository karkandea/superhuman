const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeManualKnowledge } = require('../.domain-test-dist/lib/player-knowledge.js')
const { ingestManualKnowledge } = require('../.domain-test-dist/lib/player-knowledge-service.js')
const { validateUnderstandingCandidates } = require('../.domain-test-dist/lib/player-understanding.js')
const { validateGeneratedQuestCandidates } = require('../.domain-test-dist/lib/quest-system.js')
const { derivePlayerUnderstanding, generateDailyQuests } = require('../.domain-test-dist/lib/ai/orchestrator.js')

test('manual knowledge normalization preserves natural text and validates boundaries', () => {
  const normalized = normalizeManualKnowledge({ entryType: 'life_update', text: '  Interview gue tadi gagal karena system design.  ', title: '  Interview update  ' })
  assert.equal(normalized.text, 'Interview gue tadi gagal karena system design.')
  assert.equal(normalized.title, 'Interview update')
  assert.throws(() => normalizeManualKnowledge({ entryType: 'note', text: '   ' }), /cannot be empty/)
})

test('manual ingestion sends normalized data through one atomic RPC boundary', async () => {
  let received
  const client = { rpc(name, params) { received = { name, params }; return Promise.resolve({ data: 'entry-1', error: null }) } }
  const id = await ingestManualKnowledge(client, { entryType: 'journal', text: '  Progress hari ini. ' })
  assert.equal(id, 'entry-1')
  assert.equal(received.name, 'ingest_manual_knowledge')
  assert.equal(received.params.p_raw_text, 'Progress hari ini.')
})

test('derived understanding must cite raw knowledge', () => {
  assert.throws(() => validateUnderstandingCandidates([{ type: 'obstacle', summary: 'System design gap', confidence: 0.9, sourceKnowledgeEntryIds: [] }]), /sourceKnowledgeEntryIds/)
  const [candidate] = validateUnderstandingCandidates([{ type: 'obstacle', summary: 'System design gap', confidence: 0.9, sourceKnowledgeEntryIds: ['k1'] }])
  assert.deepEqual(candidate.sourceKnowledgeEntryIds, ['k1'])
})

test('understanding orchestration rejects provider provenance outside retrieved context', async () => {
  const deps = {
    provider: { id: 'test-provider', async invokeStructured() { return { providerId: 'test-provider', modelId: 'model', output: [{ type: 'obstacle', summary: 'Invented source', confidence: 0.8, sourceKnowledgeEntryIds: ['other'] }] } } },
    contextRetriever: { async retrieveForUnderstanding() { return { playerId: 'p1', purpose: 'understanding', generatedAt: new Date().toISOString(), knowledgeEntries: [{ id: 'k1', type: 'life_update', text: 'source' }], signals: [], retrieval: { strategy: 'explicit_ids', limit: 24, reason: 'new update' } } } },
    repository: { async persistDerived() { throw new Error('must not persist') } },
  }
  await assert.rejects(() => derivePlayerUnderstanding(deps, { playerId: 'p1', knowledgeEntryIds: ['k1'] }), /outside retrieved context/)
})

test('quest validation rejects random/untraceable output', () => {
  assert.throws(() => validateGeneratedQuestCandidates([{ title: 'Random filler', category: 'pagi', kind: 'side', difficulty: 'easy', priority: 3, xp: 20, rationale: 'because', sourceSignalIds: [] }]), /sourceSignalIds/)
})

test('daily quest generation is stable on refresh and skips provider when persisted quests exist', async () => {
  let providerCalls = 0
  const existing = [{ id: 'q1', userId: 'p1', batchId: 'b1', questDate: '2026-08-18', title: 'Existing quest', category: 'siang', kind: 'main', difficulty: 'medium', priority: 1, xp: 100, rationale: 'existing', sourceSignalIds: ['s1'], source: 'ai', status: 'pending' }]
  const deps = {
    provider: { id: 'test', async invokeStructured() { providerCalls += 1; throw new Error('should not run') } },
    contextRetriever: { async retrieveForDailyQuest() { throw new Error('should not retrieve') } },
    repository: { async findForDate() { return existing }, async persistGeneratedBatch() { throw new Error('should not persist') } },
  }
  const result = await generateDailyQuests(deps, { playerId: 'p1', date: '2026-08-18' })
  assert.equal(result.source, 'existing')
  assert.equal(result.quests[0].id, 'q1')
  assert.equal(providerCalls, 0)
})

test('daily quest generation requires evidence-backed signals', async () => {
  const deps = {
    provider: { id: 'test', async invokeStructured() { throw new Error('provider must not run') } },
    contextRetriever: { async retrieveForDailyQuest() { return { playerId: 'p1', purpose: 'daily_quest', generatedAt: new Date().toISOString(), knowledgeEntries: [], signals: [], retrieval: { strategy: 'signals', limit: 32, reason: 'daily quest' } } } },
    repository: { async findForDate() { return [] }, async persistGeneratedBatch() { throw new Error('must not persist') } },
  }
  await assert.rejects(() => generateDailyQuests(deps, { playerId: 'p1', date: '2026-08-18' }), /evidence-backed player signals/)
})
