/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('player shell exposes one contextual composer on Today and Vault with mobile bottom navigation', () => {
  const layout = source('app/[username]/layout.tsx')
  assert.match(layout, /showComposer = pathname === todayPath \|\| pathname === vaultPath/)
  assert.match(layout, /<UpdateSystemComposer[\s\S]*playerId=\{player\.id\}/)
  assert.match(layout, /starterPrompts=\{pathname === vaultPath \? VAULT_STARTER_PROMPTS : undefined\}/)
  assert.match(layout, /Target gue berubah:/)
  assert.match(layout, /Ada kejadian baru:/)
  assert.match(layout, /Gue lagi mentok:/)
  assert.match(layout, /Ada hal tentang hidup gue:/)
  assert.match(layout, /Ada yang perlu System tahu hari ini\?/)
  assert.match(layout, /Ceritain apa pun ke System…/)
  assert.match(layout, /label: 'Today'/)
  assert.match(layout, /label: 'Vault'/)
  assert.match(layout, /label: 'Progression'/)
  assert.match(layout, /position: 'fixed'/)
  assert.match(layout, /bottom: 'calc\(62px \+ env\(safe-area-inset-bottom\)\)'/)
})

test('universal composer keeps input friction low and gives truthful save feedback', () => {
  const composer = source('app/[username]/update-system-composer.tsx')
  assert.match(composer, /placeholder = 'Ceritain apa pun ke System…'/)
  assert.match(composer, /starterPrompts/)
  assert.match(composer, /chooseStarter/)
  assert.match(composer, /Contoh update/)
  assert.match(composer, /MediaRecorder/)
  assert.match(composer, /createAnalyser\(\)/)
  assert.match(composer, /ingestVoiceKnowledge/)
  assert.match(composer, /superhuman:knowledge-saved/)
  assert.match(composer, /Tersimpan\. System akan mempertimbangkannya saat perlu\./)
  assert.match(composer, /Belum tersimpan\. Coba lagi\./)
  assert.match(composer, /\.txt,\.md,\.json/)
  assert.doesNotMatch(composer, /System has sufficient context/)
  assert.doesNotMatch(composer, /Calibration complete/)
  assert.doesNotMatch(composer, /Saving alone does not trigger AI reasoning/)
})

test('Today exposes clear turn ownership while Vault and Progression keep separate mental models', () => {
  const today = source('app/[username]/page.tsx')
  const vault = source('app/[username]/vault/page.tsx')
  const progression = source('app/[username]/history/page.tsx')
  const understanding = source('lib/system-understanding-ui.ts')

  assert.match(today, /SYSTEM YANG LANJUT/)
  assert.match(today, /GILIRAN LO/)
  assert.match(today, /System lagi memulihkan proses/)
  assert.match(today, /Bola ada di System\. Lo nggak perlu ngapa-ngapain\./)
  assert.match(today, /Lagi memahami jawaban lo/)
  assert.match(today, /Lagi nentuin fokus hari ini/)
  assert.match(today, /Lagi nyusun quest/)
  assert.match(today, /Lo nggak perlu ngapa-ngapain\./)
  assert.match(today, /MUAT ULANG STATUS/)
  assert.doesNotMatch(today, /NGGAK ADA ACTION DARI LO/)
  assert.doesNotMatch(today, /Progression Map/)
  assert.doesNotMatch(today, /response history/)
  assert.doesNotMatch(today, /UpdateSystemComposer/)
  assert.doesNotMatch(today, /STRATEGIC TARGET · EXECUTABLE PLAN/)

  assert.match(vault, /Yang lo ceritain ke System, tersimpan di sini\./)
  assert.match(vault, /PEMAHAMAN SYSTEM/)
  assert.match(vault, /UPDATE TERBARU/)
  assert.match(vault, /TITIK AWAL/)
  assert.match(vault, /LIHAT JAWABAN →/)
  assert.match(vault, /LIHAT TRANSKRIP →/)
  assert.match(vault, /CEK STATUS/)
  assert.match(vault, /understanding_sources/)
  assert.doesNotMatch(vault, /requestDailyQuestGeneration/)
  assert.doesNotMatch(vault, /WHAT TO SHARE/)
  assert.doesNotMatch(vault, /HOW LIFE VAULT WORKS/)
  assert.doesNotMatch(vault, /RECENT KNOWLEDGE/)
  assert.doesNotMatch(vault, /Everything the System knows from what you’ve shared\./)
  assert.doesNotMatch(vault, /SystemFreshnessCard/)
  assert.doesNotMatch(vault, /UpdateSystemComposer/)

  assert.match(progression, /deriveUnderstandingStage/)
  assert.match(progression, /CURRENT PICTURE/)
  assert.match(progression, /Yang kebaca sekarang/)
  assert.match(progression, /WHAT CHANGED/)
  assert.match(progression, /Pemahaman yang bergerak/)
  assert.match(progression, /EXECUTION/)
  assert.match(progression, /30 hari terakhir/)
  assert.match(progression, /LIHAT SEMUA 30 HARI →/)
  assert.doesNotMatch(progression, />30 days</)

  assert.match(understanding, /PLAYER UNDERSTANDING/)
  assert.match(understanding, /Titik awal/)
  assert.match(understanding, /Gambaran awal udah kebaca/)
  assert.match(understanding, /Pola mulai terlihat/)
  assert.match(understanding, /modelPatternCount/)
  assert.match(understanding, /strategicNodeCount/)
  assert.doesNotMatch(understanding, /percentage|percent|\d+%/i)
})

test('authentication defaults to magic link while preserving password sign-in and production redirect', () => {
  const home = source('app/page.tsx')
  assert.match(home, /Your System is waiting\./)
  assert.match(home, /const PRODUCTION_SITE_URL = 'https:\/\/superhuman\.dualangka\.com'/)
  assert.match(home, /function authRedirectUrl\(\) \{\s*return PRODUCTION_SITE_URL\s*\}/)
  assert.doesNotMatch(home, /NEXT_PUBLIC_SITE_URL/)
  assert.match(home, /signInWithOtp/)
  assert.match(home, /emailRedirectTo: authRedirectUrl\(\)/)
  assert.match(home, /shouldCreateUser: authMode === 'register'/)
  assert.match(home, /Check your email\./)
  assert.match(home, /We sent you a secure sign-in link\./)
  assert.match(home, /signInWithPassword/)
  assert.match(home, /USE PASSWORD/)
  assert.match(home, /EMAIL ME A SIGN-IN LINK/)
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
    player: { id: 'player-1', name: 'Player', timezone: 'Asia/Jakarta' }, activeUnderstandingIds: [], highlights: [],
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
