/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('progression episodes are private readable history with narrow write RPCs', () => {
  const sql = source('supabase/sql/add_progression_conversation_experience.sql')
  assert.match(sql, /create table if not exists public\.progression_sessions/)
  assert.match(sql, /create table if not exists public\.progression_messages/)
  assert.match(sql, /create table if not exists public\.progression_research/)
  assert.match(sql, /create table if not exists public\.progression_questions/)
  assert.match(sql, /enable row level security/g)
  assert.match(sql, /using \(\(select auth\.uid\(\)\)=user_id\)/)
  assert.match(sql, /revoke all on public\.progression_messages from anon,authenticated/)
  assert.match(sql, /grant select on public\.progression_messages to authenticated/)
  assert.match(sql, /grant execute on function public\.answer_progression_question\(uuid,jsonb\) to authenticated/)
  assert.match(sql, /grant execute on function public\.ensure_progression_session_operator\(uuid,date,uuid\) to service_role/)
})

test('progression move is a bounded decision gate instead of an always-quest agent', () => {
  const runtime = source('lib/ai/progression-conversation-intelligence.ts')
  const contract = source('lib/progression-conversation.ts')
  assert.match(contract, /'ask' \| 'research' \| 'quest' \| 'decide' \| 'wait'/)
  assert.match(contract, /PROGRESSION_RESEARCH_MAX_PER_SESSION = 2/)
  assert.match(contract, /PLAYER_UPDATE_MAX = 2/)
  assert.match(contract, /dropped decision-relevant evidence before quest targeting/)
  assert.match(runtime, /for \(let pass = 0; pass < 3; pass \+= 1\)/)
  assert.match(runtime, /questionBudgetRemaining: Math\.max\(0, 3 - usedQuestions\)/)
  assert.match(runtime, /Never transform the player problem into the task itself/)
  assert.match(runtime, /information-gain experiment/)
  assert.match(runtime, /Player Brief \+ private signals \+ observed quest results remain the source of truth about the player/)
})

test('initial progression requires real external research and preserves source URLs', () => {
  const runtime = source('lib/ai/progression-conversation-intelligence.ts')
  const transport = source('workers/chatgpt-consumer/browser-transport.mjs')
  const provider = source('lib/ai/chatgpt-consumer-provider.ts')
  assert.match(runtime, /first post-onboarding progression decision/)
  assert.match(runtime, /Use external web search for this request\. Do not answer from memory alone\./)
  assert.match(runtime, /never the player identity/)
  assert.match(runtime, /sources: \[\{/)
  assert.match(provider, /webSearch: request\.operation === 'research_progression_context'/)
  assert.match(transport, /async function activateWebSearch/)
  assert.match(transport, /web_search_unavailable/)
  assert.match(transport, /research=search-ui/)
})

test('Home renders actual session state and interactive material clarification', () => {
  const shell = source('app/[username]/today-conversation-shell.tsx')
  const layout = source('app/[username]/layout.tsx')
  assert.match(shell, /SYSTEM · RESEARCHING/)
  assert.match(shell, /SYSTEM · DECIDING/)
  assert.match(shell, /SYSTEM · NEEDS INPUT/)
  assert.match(shell, /answerProgressionQuestion/)
  assert.match(shell, /JAWAB →/)
  assert.match(shell, /history\/sessions/)
  assert.match(layout, /<TodayConversationShell playerId=\{player\.id\}/)
})
