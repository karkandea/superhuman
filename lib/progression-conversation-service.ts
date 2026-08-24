import type { SupabaseClient } from '@supabase/supabase-js'

export type ProgressionSessionState = 'understanding' | 'need_clarification' | 'researching' | 'deciding' | 'quest_ready' | 'waiting' | 'stopped'
export type ProgressionSessionKind = 'initial_calibration' | 'progression' | 'reevaluation'
export type ProgressionQuestionResponseType = 'free_text' | 'short_text' | 'single_choice' | 'multiple_choice'

export interface ProgressionConversationSession {
  id: string
  title: string
  kind: ProgressionSessionKind
  state: ProgressionSessionState
  status: 'active' | 'closed'
  targetDate?: string
  metadata: Record<string, unknown>
  openedAt: string
  updatedAt: string
}

export interface ProgressionConversationMessage {
  id: string
  actor: 'player' | 'system'
  type: string
  body: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface ProgressionConversationQuestion {
  id: string
  responseType: ProgressionQuestionResponseType
  prompt: string
  reason: string
  options: string[]
  createdAt: string
}

export interface ProgressionInitializationAnswer {
  id: string
  prompt: string
  answer: string
  origin: 'basic' | 'adaptive'
  answeredAt?: string
}

export interface ProgressionSessionSummary {
  id: string
  title: string
  kind: ProgressionSessionKind
  state: ProgressionSessionState
  status: 'active' | 'closed'
  openedAt: string
  closedAt?: string
}

export interface ProgressionConversationSnapshot {
  session: ProgressionConversationSession | null
  messages: ProgressionConversationMessage[]
  question: ProgressionConversationQuestion | null
  initialAnswers: ProgressionInitializationAnswer[]
  recentSessions: ProgressionSessionSummary[]
}

function row(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function string(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function mapSession(value: unknown): ProgressionConversationSession | null {
  if (!value) return null
  const item = row(value)
  const id = string(item.id)
  if (!id) return null
  return {
    id,
    title: string(item.title),
    kind: item.kind as ProgressionSessionKind,
    state: item.state as ProgressionSessionState,
    status: (item.status as 'active' | 'closed') || 'active',
    ...(string(item.targetDate) ? { targetDate: string(item.targetDate) } : {}),
    metadata: row(item.metadata),
    openedAt: string(item.openedAt),
    updatedAt: string(item.updatedAt),
  }
}

function mapSnapshot(value: unknown): ProgressionConversationSnapshot {
  const data = row(value)
  return {
    session: mapSession(data.session),
    messages: (Array.isArray(data.messages) ? data.messages : []).map(raw => {
      const item = row(raw)
      return {
        id: string(item.id),
        actor: item.actor === 'player' ? 'player' : 'system',
        type: string(item.type),
        body: string(item.body),
        metadata: row(item.metadata),
        createdAt: string(item.createdAt),
      }
    }),
    question: data.question ? (() => {
      const item = row(data.question)
      return {
        id: string(item.id),
        responseType: item.responseType as ProgressionQuestionResponseType,
        prompt: string(item.prompt),
        reason: string(item.reason),
        options: Array.isArray(item.options) ? item.options.map(string).filter(Boolean) : [],
        createdAt: string(item.createdAt),
      }
    })() : null,
    initialAnswers: (Array.isArray(data.initialAnswers) ? data.initialAnswers : []).map(raw => {
      const item = row(raw)
      return {
        id: string(item.id),
        prompt: string(item.prompt),
        answer: string(item.answer),
        origin: item.origin === 'adaptive' ? 'adaptive' : 'basic',
        ...(string(item.answeredAt) ? { answeredAt: string(item.answeredAt) } : {}),
      }
    }).filter(item => item.answer),
    recentSessions: (Array.isArray(data.recentSessions) ? data.recentSessions : []).map(raw => {
      const item = row(raw)
      return {
        id: string(item.id),
        title: string(item.title),
        kind: item.kind as ProgressionSessionKind,
        state: item.state as ProgressionSessionState,
        status: item.status === 'closed' ? 'closed' : 'active',
        openedAt: string(item.openedAt),
        ...(string(item.closedAt) ? { closedAt: string(item.closedAt) } : {}),
      }
    }).filter(item => item.id),
  }
}

export async function ensureProgressionSession(client: SupabaseClient, targetDate?: string) {
  const { error } = await client.rpc('ensure_player_progression_session', { p_target_date: targetDate ?? null })
  if (error) throw new Error(`ensure progression session: ${error.message}`)
}

export async function loadProgressionConversation(client: SupabaseClient): Promise<ProgressionConversationSnapshot> {
  const { data, error } = await client.rpc('get_progression_conversation_snapshot')
  if (error) throw new Error(`load progression conversation: ${error.message}`)
  return mapSnapshot(data)
}

export async function answerProgressionQuestion(
  client: SupabaseClient,
  questionId: string,
  answer: string | string[],
) {
  const payload = Array.isArray(answer) ? answer : answer.trim()
  const { data, error } = await client.rpc('answer_progression_question', {
    p_question_id: questionId,
    p_answer: payload,
  })
  if (error) throw new Error(`answer progression question: ${error.message}`)
  return row(data)
}
