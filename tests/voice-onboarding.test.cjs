/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('voice onboarding migration keeps raw audio private and evidence-backed', () => {
  const sql = source('supabase/sql/add_player_initialization_voice_answers.sql')
  assert.match(sql, /'player-initialization-audio'/)
  assert.match(sql, /false,\s*15728640/)
  assert.match(sql, /split_part\(name,'\/',1\)=\(select auth\.uid\(\)\)::text/)
  assert.match(sql, /submit_player_initialization_voice_answer/)
  assert.match(sql, /Raw audio is the source evidence; transcript is pending calibration/)
  assert.match(sql, /persist_player_initialization_calibration_v2_internal/)
  assert.match(sql, /update_player_initialization_voice_transcript/)
  assert.match(sql, /Player initialization transcript correction/)
})

test('onboarding recorder keeps raw voice inside one answer composer without invoking AI', () => {
  const recorder = source('app/[username]/voice-answer-recorder.tsx')
  const service = source('lib/player-initialization-voice-service.ts')
  assert.match(recorder, /MediaRecorder/)
  assert.match(recorder, /LISTENING/)
  assert.match(recorder, /VOICE ANSWER/)
  assert.match(recorder, /RE-RECORD/)
  assert.match(recorder, /VOICE PRIVACY/)
  assert.match(service, /player-initialization-audio/)
  assert.match(service, /submit_player_initialization_voice_answer/)
  assert.doesNotMatch(service, /invokeStructured|AiProvider|ChatGptConsumerWebProvider/)
})

test('player calibration screen is single-task and hides architecture copy', () => {
  const page = source('app/[username]/player-initialization.tsx')
  assert.match(page, /SYSTEM CALIBRATION/)
  assert.match(page, /BEGIN CALIBRATION →/)
  assert.match(page, /LANJUT →/)
  assert.match(page, /✓ Got it\./)
  assert.match(page, /Ceritain di sini…/)
  assert.doesNotMatch(page, /PLAYER CONTEXT/)
  assert.doesNotMatch(page, /BASE CONTEXT/)
  assert.doesNotMatch(page, /OR TALK TO THE SYSTEM/)
  assert.doesNotMatch(page, /Text or raw audio becomes Life Vault evidence/)
  assert.doesNotMatch(page, /PROGRESS IS SAVED/)
  assert.doesNotMatch(page, /LAST SYSTEM ASSESSMENT/)
  assert.doesNotMatch(page, /Give the System enough reality to work with/)
})

test('calibration v2 binds raw audio and transcript to the same reasoning invocation', () => {
  const orchestrator = source('lib/ai/player-initialization-orchestrator.ts')
  assert.match(orchestrator, /player-initialization-calibration\.v2/)
  assert.match(orchestrator, /operation: 'calibrate_player_initialization'/)
  assert.match(orchestrator, /attachments: attachments\.map/)
  assert.match(orchestrator, /required: \['actions', 'readiness', 'reason', 'dimensions', 'questions', 'voiceTranscripts'\]/)
  assert.match(orchestrator, /persistInitializationRuntimeDecision\(input\.playerId, decision, voiceTranscripts, audit\)/)
  assert.match(orchestrator, /cover every attached audio answer exactly once/)

  const contracts = source('lib/ai/contracts.ts')
  assert.doesNotMatch(contracts, /transcribe_audio|transcribe_voice|speech_to_text/)
})

test('consumer provider forwards audio attachments once while keeping signed URL out of prompt', async () => {
  const { ChatGptConsumerWebProvider } = require('../.domain-test-dist/lib/ai/chatgpt-consumer-provider.js')
  let captured = null
  const transport = {
    execute: async input => {
      captured = input
      return {
        text: JSON.stringify({
          requestId: 'voice-request-1',
          operation: 'calibrate_player_initialization',
          schemaVersion: 'player-initialization-calibration.v2',
          payload: { ok: true },
        }),
        modelLabel: 'fake-consumer-model',
      }
    },
  }
  const provider = new ChatGptConsumerWebProvider(transport, { idFactory: () => 'voice-request-1' })
  const secretSignedUrl = 'https://storage.example.invalid/private/audio?token=secret'
  const response = await provider.invokeStructured({
    operation: 'calibrate_player_initialization',
    schemaVersion: 'player-initialization-calibration.v2',
    instructions: 'Understand the attached raw voice answer in this same call.',
    context: { playerId: 'p1', initialization: { questions: [] } },
    responseContract: { type: 'object' },
    attachments: [{
      id: 'initialization-audio:q1',
      kind: 'audio',
      fileName: 'voice.m4a',
      mimeType: 'audio/mp4',
      sourceUrl: secretSignedUrl,
      label: 'Question q1',
    }],
  })

  assert.equal(response.providerId, 'chatgpt-consumer-web')
  assert.equal(captured.attachments.length, 1)
  assert.equal(captured.attachments[0].sourceUrl, secretSignedUrl)
  assert.match(captured.prompt, /ATTACHMENT_MANIFEST/)
  assert.match(captured.prompt, /initialization-audio:q1/)
  assert.doesNotMatch(captured.prompt, /token=secret/)
})

test('browser transport has bounded file attachment support but ordinary tests never invoke it', () => {
  const transport = source('workers/chatgpt-consumer/browser-transport.mjs')
  assert.match(transport, /setInputFiles\(filePaths\)/)
  assert.match(transport, /MAX_ATTACHMENT_BYTES = 15 \* 1024 \* 1024/)
  assert.match(transport, /superhuman-ai-attachments-/)
  assert.match(transport, /materialized\.cleanup\(\)/)
})

test('player origin history exposes generated voice transcript and player correction', () => {
  const page = source('app/[username]/history/onboarding/page.tsx')
  assert.match(page, /VOICE → TRANSCRIPT/)
  assert.match(page, /EDIT TRANSCRIPT/)
  assert.match(page, /SAVE CORRECTION/)
  assert.match(page, /does not delete the original raw audio/)
  assert.match(page, /updateInitializationVoiceTranscript/)
})
