/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('first quest reveal is reserved for the player first-ever quest', () => {
  const reveal = source('app/[username]/first-quest-reveal.tsx')
  const layout = source('app/[username]/layout.tsx')

  assert.match(reveal, /\.lt\('quest_date', date\)/)
  assert.match(reveal, /priorCount/)
  assert.match(reveal, /FIRST QUEST/)
  assert.match(reveal, /Mulai dari ini\./)
  assert.match(reveal, /Nggak perlu gerakin semuanya\. Satu langkah ini dulu\./)
  assert.match(reveal, /LIHAT QUEST →/)
  assert.match(reveal, /superhuman\.first-quest-reveal:/)
  assert.match(reveal, /item\.kind === 'main'/)
  assert.match(layout, /<FirstQuestReveal playerId=\{player\.id\} active=\{pathname === todayPath\} \/>/)
})

test('system moments use truthful indeterminate progress instead of a fake ETA', () => {
  const onboarding = source('app/[username]/player-initialization.tsx')
  const moment = source('app/[username]/system-moment.tsx')

  assert.match(moment, /superhuman-system-scan/)
  assert.match(moment, /Jawaban lo udah masuk\./)
  assert.match(moment, /Masih jalan\. Lo nggak perlu ngapa-ngapain\./)
  assert.match(moment, /Agak lebih lama dari biasanya\. Jawaban lo aman\./)
  assert.doesNotMatch(onboarding, /\~00:|00:45|00:38|countdown/i)
  assert.doesNotMatch(moment, /\~00:|00:45|00:38|countdown/i)
})

test('first quest reveal reads quest state only and never invokes AI', () => {
  const reveal = source('app/[username]/first-quest-reveal.tsx')
  assert.match(reveal, /from\('daily_quests'\)/)
  assert.doesNotMatch(reveal, /requestDailyQuestGeneration|invokeStructured|AiProvider|ChatGptConsumerWebProvider/)
})
