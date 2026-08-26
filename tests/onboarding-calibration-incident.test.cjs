/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('onboarding audio fills and verifies prompt before multi-file attachment processing', () => {
  const transport = source('workers/chatgpt-consumer/browser-transport.mjs')
  const executeStart = transport.indexOf('export class PlaywrightChatGptTransport')
  const executeSource = transport.slice(executeStart)
  const verifiedFillIndex = executeSource.indexOf('await fillComposerVerified(composer, prompt, deadline)')
  const attachIndex = executeSource.indexOf('await attachFiles(page, materialized.paths, deadline)')

  assert.ok(verifiedFillIndex >= 0, 'verified composer fill must exist')
  assert.ok(attachIndex >= 0, 'attachment upload must exist')
  assert.ok(verifiedFillIndex < attachIndex, 'prompt must be filled and verified before attachments are processed')
  assert.match(transport, /async function fillComposerVerified\(composer, prompt, deadline\)/)
  assert.match(transport, /await composer\.fill\(prompt/)
  assert.match(transport, /composerTextMatches\(prompt, candidates\)/)
  assert.match(transport, /composer_fill_failed/)
  assert.match(executeSource, /waitForSendReady\(page, deadline\)/)
  assert.match(executeSource, /attachment_upload_timeout/)
  assert.match(executeSource, /\[requestId=\$\{correlationId\}\]/)
})

test('calibration telemetry is privacy-safe and captures behavior shape', () => {
  const sql = source('supabase/sql/add_player_initialization_calibration_telemetry.sql')

  assert.match(sql, /player_initialization_calibration_attempts/)
  assert.match(sql, /answered_count/)
  assert.match(sql, /skipped_count/)
  assert.match(sql, /text_answer_count/)
  assert.match(sql, /text_length_chars/)
  assert.match(sql, /audio_answer_count/)
  assert.match(sql, /audio_duration_ms/)
  assert.match(sql, /adaptive_followups_generated/)
  assert.match(sql, /latency_ms/)
  assert.match(sql, /failure_code/)
  assert.match(sql, /is_first_calibration/)
  assert.match(sql, /status in \('running','ready','ask','failed'\)/)

  assert.match(sql, /char_length\(coalesce\(q\.answer_text,''\)\)/)
  assert.doesNotMatch(sql, /'answerText'/)
  assert.doesNotMatch(sql, /'transcriptText'/)
  assert.doesNotMatch(sql, /q\.transcript_text/)
  assert.match(sql, /revoke all on table public\.player_initialization_calibration_attempts from anon, authenticated/)
})

test('transport failure request id is extracted before DB error redaction', () => {
  const sql = source('supabase/sql/add_player_initialization_calibration_telemetry.sql')

  assert.match(sql, /extract_ai_request_id/)
  assert.match(sql, /v_request_id text:=public\.extract_ai_request_id\(p_error_message\)/)
  assert.match(sql, /set request_id=v_request_id/)
  assert.match(sql, /safe_ai_failure_message/)
  assert.match(sql, /ChatGPT composer did not accept the request before timeout\./)
  assert.doesNotMatch(sql, /left\(coalesce\(p_error_message,''\),2000\)/)
})

test('incident hardening does not change the five basic onboarding questions', () => {
  const initializationSql = source('supabase/sql/add_player_initialization_readiness.sql')
  const conversationalSql = fs.existsSync(path.join(process.cwd(), 'supabase/sql/refine_player_initialization_questions.sql'))
    ? source('supabase/sql/refine_player_initialization_questions.sql')
    : source('supabase/sql/add_player_initialization_readiness.sql')
  const combined = `${initializationSql}\n${conversationalSql}`

  // Existing regression suite owns the exact locked copy. This incident suite only ensures
  // the transport/telemetry patch does not introduce a second question definition.
  assert.doesNotMatch(source('workers/chatgpt-consumer/browser-transport.mjs'), /Sekarang keseharian lo/)
  assert.doesNotMatch(source('supabase/sql/add_player_initialization_calibration_telemetry.sql'), /Sekarang keseharian lo/)
  assert.match(combined, /player_initialization/)
})
