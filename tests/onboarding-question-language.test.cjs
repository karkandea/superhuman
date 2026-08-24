/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('basic onboarding uses the locked conversational five-question journey', () => {
  const sql = source('supabase/sql/refine_player_initialization_questions_v2.sql')

  const expected = [
    'Sekarang keseharian lo lagi kayak gimana?',
    'Biasanya seminggu lo kayak gimana? Kapan paling sibuk, dan kapan biasanya agak kosong?',
    'Beberapa minggu ke depan, apa yang paling pengen lo fokusin?',
    'Kalau itu berjalan sesuai yang lo mau, hasil yang pengen lo lihat tuh kayak gimana?',
    'Sekarang yang paling bikin susah buat sampai ke sana apa?',
  ]

  for (const prompt of expected) assert.match(sql, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  assert.match(sql, /'life_context','current_state'/)
  assert.match(sql, /'schedule_structure','capacity_constraints'/)
  assert.match(sql, /'current_direction','direction'/)
  assert.match(sql, /'desired_outcome','direction'/)
  assert.match(sql, /'major_constraint','bottleneck_opportunity'/)
  assert.doesNotMatch(sql, /Sekarang lo lagi ada di fase hidup seperti apa\?/)
  assert.doesNotMatch(sql, /Hari-hari lo sekarang paling banyak diisi aktivitas atau peran apa\?/)
  assert.doesNotMatch(sql, /Pola waktu lo biasanya kayak gimana dalam seminggu\?/)
})

test('onboarding UI shows helper copy only where it removes ambiguity', () => {
  const page = source('app/[username]/player-initialization.tsx')

  assert.match(page, /BASIC_QUESTION_HELPERS/)
  assert.match(page, /Lagi kerja, kuliah, ngurus sesuatu, atau ada hal lain yang paling banyak makan waktu lo\?/)
  assert.match(page, /Pilih satu yang paling pengen lo dorong dulu\./)
  assert.match(page, /Bisa waktu, tenaga, uang, bingung mulai dari mana, atau hal lain\./)
  assert.match(page, /BASIC_QUESTION_HELPERS\[question\.questionKey\] \?\? null/)
  assert.match(page, /questionHelper &&/)
  assert.match(page, /color: S\.muted, fontSize: 12\.5/)
})

test('basic onboarding can go back and replace prior evidence before calibration', () => {
  const page = source('app/[username]/player-initialization.tsx')
  const service = source('lib/player-initialization-service.ts')
  const sql = source('supabase/sql/add_onboarding_answer_back_navigation.sql')

  assert.match(page, /← KEMBALI/)
  assert.match(page, /reopenPreviousPlayerInitializationQuestion/)
  assert.match(page, /currentCalibrationVersion === 0/)
  assert.match(page, /state\.lastCalibratedAt === null/)
  assert.match(page, /const current = nextQuestion\(next\.questions\)/)
  assert.match(page, /setAnswer\(current\?\.answerText \?\? ''\)/)
  assert.doesNotMatch(page, /useEffect\(\(\) => \{\s*setAnswer\(question\?\.answerText/)
  assert.match(service, /reopen_previous_player_initialization_question/)

  assert.match(sql, /origin='basic'/)
  assert.match(sql, /status='answered'/)
  assert.match(sql, /sequence < v_before_sequence/)
  assert.match(sql, /processing_status='ignored'/)
  assert.match(sql, /status='pending'/)
  assert.match(sql, /answer_text=case when v_previous_mode='text' then v_previous_answer else null end/)
  assert.match(sql, /calibration_version<>0/)
  assert.match(sql, /revoke all on function public\.reopen_previous_player_initialization_question\(uuid\) from public,anon/)
  assert.match(sql, /grant execute on function public\.reopen_previous_player_initialization_question\(uuid\) to authenticated/)
})
