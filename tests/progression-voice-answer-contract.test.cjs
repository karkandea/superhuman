const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const migration = fs.readFileSync(path.join(process.cwd(), 'supabase/sql/add_progression_voice_answers.sql'), 'utf8')
const service = fs.readFileSync(path.join(process.cwd(), 'lib/progression-conversation-service.ts'), 'utf8')

test('progression voice answers bind raw audio evidence to the pending question before requeue', () => {
  assert.match(migration, /answer_progression_question_voice/)
  assert.match(migration, /response_type not in \('free_text','short_text'\)/)
  assert.match(migration, /answer_knowledge_entry_id=v_entry\.id/)
  assert.match(migration, /voiceRole','clarification_answer'/)
  assert.match(migration, /request_progression_cycle/)
  assert.match(service, /answerProgressionQuestionWithVoice/)
})
