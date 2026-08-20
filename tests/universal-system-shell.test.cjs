/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('player shell exposes one composer on Today and Vault with mobile bottom navigation', () => {
  const layout = source('app/[username]/layout.tsx')
  assert.match(layout, /showComposer = pathname === todayPath \|\| pathname === vaultPath/)
  assert.match(layout, /<UpdateSystemComposer playerId=\{player\.id\}/)
  assert.match(layout, /label: 'Today'/)
  assert.match(layout, /label: 'Vault'/)
  assert.match(layout, /label: 'Progression'/)
  assert.match(layout, /position: 'fixed'/)
  assert.match(layout, /bottom: 'calc\(62px \+ env\(safe-area-inset-bottom\)\)'/)
})

test('universal composer unifies text file and responsive raw voice capture', () => {
  const composer = source('app/[username]/update-system-composer.tsx')
  assert.match(composer, /Tell the System anything…/)
  assert.match(composer, /MediaRecorder/)
  assert.match(composer, /createAnalyser\(\)/)
  assert.match(composer, /ingestVoiceKnowledge/)
  assert.match(composer, /superhuman:knowledge-saved/)
  assert.match(composer, /✓ Saved/)
  assert.match(composer, /\.txt,\.md,\.json/)
  assert.doesNotMatch(composer, /SEND UPDATE/)
  assert.doesNotMatch(composer, /Saving alone does not trigger AI reasoning/)
})

test('Today and Life Vault hide architecture dashboards behind consumer surfaces', () => {
  const today = source('app/[username]/page.tsx')
  const vault = source('app/[username]/vault/page.tsx')

  assert.match(today, /SYSTEM DECIDING/)
  assert.match(today, /Choosing today’s quests…/)
  assert.match(today, /Finding the highest-leverage move\./)
  assert.doesNotMatch(today, /Progression Map/)
  assert.doesNotMatch(today, /response history/)
  assert.doesNotMatch(today, /UpdateSystemComposer/)
  assert.doesNotMatch(today, /STRATEGIC TARGET · EXECUTABLE PLAN/)

  assert.match(vault, /Everything the System knows from what you’ve shared\./)
  assert.match(vault, /RECENT KNOWLEDGE/)
  assert.match(vault, /🎙 Voice update/)
  assert.doesNotMatch(vault, /SystemFreshnessCard/)
  assert.doesNotMatch(vault, /UpdateSystemComposer/)
  assert.doesNotMatch(vault, /LATEST 40/)
})

test('authentication is email-first magic link instead of password dashboard', () => {
  const home = source('app/page.tsx')
  assert.match(home, /Your System is waiting\./)
  assert.match(home, /signInWithOtp/)
  assert.match(home, /shouldCreateUser: authMode === 'register'/)
  assert.match(home, /Check your email\./)
  assert.match(home, /We sent you a secure sign-in link\./)
  assert.doesNotMatch(home, /signInWithPassword/)
  assert.doesNotMatch(home, /registerWithPassword/)
  assert.doesNotMatch(home, /SET \/ RESET PASSWORD/)
})

test('generic voice evidence stays private and save-only until a reasoning cycle', () => {
  const sql = source('supabase/sql/add_player_knowledge_voice_updates.sql')
  const service = source('lib/player-knowledge-voice-service.ts')
  const runtime = source('workers/chatgpt-consumer/voice-knowledge-runtime.mjs')

  assert.match(sql, /'player-knowledge-audio'/)
  assert.match(sql, /false,\s*15728640/)
  assert.match(sql, /split_part\(name,'\/',1\)=\(select auth\.uid\(\)\)::text/)
  assert.match(sql, /ingest_manual_voice_knowledge/)
  assert.match(sql, /persist_knowledge_voice_transcripts_internal/)
  assert.doesNotMatch(sql, /request_progression_cycle/)
  assert.match(service, /ingest_manual_voice_knowledge/)
  assert.doesNotMatch(service, /AiProvider|invokeStructured|ChatGptConsumerWebProvider/)
  assert.match(runtime, /createSignedUrl/)
  assert.match(runtime, /transcriptStatus === 'ready'/)
  assert.match(runtime, /persist_knowledge_voice_transcripts_internal/)
})

test('one FakeAiProvider call understands raw activity audio and returns its transcript with the delta', async () => {
  const { FakeAiProvider } = require('../.domain-test-dist/lib/ai/fake-ai-provider.js')
  const { derivePlayerUnderstandingDelta } = require('../.domain-test-dist/lib/ai/activity-understanding-orchestrator.js')

  const knowledgeId = '11111111-1111-4111-8111-111111111111'
  const provider = new FakeAiProvider({
    fixtures: [{
      operation: 'derive_understanding_delta',
      output: {
        actions: [],
        voiceTranscripts: [{ sourceKnowledgeEntryId: knowledgeId, transcript: 'Besok interview gue dimajuin jam sembilan.' }],
      },
    }],
  })
  const persistedTranscripts = []
  let deltaPersisted = false
  const playerBrief = {
    id: 'brief-1', version: 1, schemaVersion: 'player-brief.v1', reason: 'test', createdAt: '2026-08-20T00:00:00Z', generatedAt: '2026-08-20T00:00:00Z',
    player: { id: 'player-1', name: 'Player', timezone: 'Asia/Jakarta' },
    activeUnderstandingIds: [], highlights: [],
    sections: { goals: [], obstacles: [], opportunities: [], constraints: [], preferences: [], relationships: [], events: [], priorities: [] },
    activeSignals: [], counts: { activeUnderstanding: 0, activeSignals: 0 },
  }
  const context = {
    playerId: 'player-1', purpose: 'understanding', generatedAt: '2026-08-20T00:00:00Z', playerBrief,
    knowledgeEntries: [{ id: knowledgeId, type: 'life_update', text: '[Voice update attached.]' }],
    signals: [], recentQuestResults: [], activeQuests: [],
    retrieval: { strategy: 'test', limit: 1, reason: 'test' },
  }

  const result = await derivePlayerUnderstandingDelta({
    provider,
    contextRetriever: {
      retrieveForUnderstandingDelta: async () => context,
      retrieveForUnderstanding: async () => context,
    },
    repository: {
      persistDerived: async () => {},
      persistVoiceTranscripts: async input => { persistedTranscripts.push(...input.transcripts) },
      persistDelta: async () => {
        deltaPersisted = true
        return { deltaBatchId: 'delta-1', actionCount: 0, playerBriefId: 'brief-1', playerBriefVersion: 1, playerBriefChanged: false, source: 'persisted' }
      },
    },
  }, {
    playerId: 'player-1', knowledgeEntryIds: [knowledgeId], date: '2026-08-20', batchKey: 'voice-test',
    voiceAttachments: [{
      sourceKnowledgeEntryId: knowledgeId,
      attachment: { id: `knowledge-audio:${knowledgeId}`, kind: 'audio', fileName: 'voice.m4a', mimeType: 'audio/mp4', sourceUrl: 'https://example.invalid/private-signed-audio' },
    }],
  })

  assert.equal(provider.calls.length, 1)
  assert.equal(provider.calls[0].request.operation, 'derive_understanding_delta')
  assert.equal(provider.calls[0].request.schemaVersion, 'understanding-delta.v2')
  assert.equal(provider.calls[0].request.attachments.length, 1)
  assert.deepEqual(persistedTranscripts, [{ sourceKnowledgeEntryId: knowledgeId, transcript: 'Besok interview gue dimajuin jam sembilan.' }])
  assert.equal(deltaPersisted, true)
  assert.equal(result.persistence.actionCount, 0)
  provider.assertExhausted()
})
