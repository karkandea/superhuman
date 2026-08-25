'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  answerProgressionQuestion,
  ensureProgressionSession,
  loadProgressionConversation,
  type ProgressionConversationQuestion,
  type ProgressionConversationSnapshot,
  type ProgressionSessionState,
} from '@/lib/progression-conversation-service'
import { supabase } from '@/lib/supabase'
import ConversationBubble from './conversation-bubble'
import ConversationHeader, { AgentTypingIndicator } from './conversation-header'
import ProgressionVoiceAnswerRecorder from './progression-voice-answer-recorder'

const S = {
  panel: '#13171f', panel2: '#10141b', line: '#232a35', ink: '#ECEAE3', muted: '#7e8795',
  muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

const STATE_COPY: Record<ProgressionSessionState, { eyebrow: string; title: string }> = {
  understanding: { eyebrow: 'SYSTEM · UNDERSTANDING', title: 'Gue lagi nyusun konteksnya.' },
  need_clarification: { eyebrow: 'SYSTEM · NEEDS INPUT', title: 'Ada satu hal yang bisa ngubah keputusan berikutnya.' },
  researching: { eyebrow: 'SYSTEM · RESEARCHING', title: 'Gue lagi cek dunia di luar konteks lo.' },
  deciding: { eyebrow: 'SYSTEM · DECIDING', title: 'Buktinya cukup. Gue lagi milih next move.' },
  quest_ready: { eyebrow: 'SYSTEM · READY', title: 'Next move udah siap.' },
  waiting: { eyebrow: 'SYSTEM · OBSERVING', title: 'Belum perlu nambah action sembarangan.' },
  stopped: { eyebrow: 'SYSTEM · STOPPED', title: 'Prosesnya lagi berhenti.' },
}

function stateNeedsFocus(state: ProgressionSessionState) {
  return state === 'understanding' || state === 'researching' || state === 'deciding' || state === 'need_clarification'
}

function stateIsWorking(state: ProgressionSessionState) {
  return state === 'understanding' || state === 'researching' || state === 'deciding'
}

function formatMoment(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}

export default function TodayConversationShell({
  playerId,
  username,
  children,
  onConversationInputModeChange,
}: {
  playerId: string
  username: string
  children: ReactNode
  onConversationInputModeChange?: (active: boolean) => void
}) {
  const [snapshot, setSnapshot] = useState<ProgressionConversationSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const applySnapshot = useCallback((next: ProgressionConversationSnapshot) => {
    setSnapshot(next)
    setLoadError(false)
    setLoading(false)
    onConversationInputModeChange?.(Boolean(next.question))
    return next
  }, [onConversationInputModeChange])

  const reload = useCallback(async () => {
    await ensureProgressionSession(supabase)
    const next = await loadProgressionConversation(supabase)
    return applySnapshot(next)
  }, [applySnapshot])

  useEffect(() => {
    let cancelled = false

    async function loadInitialConversation() {
      await ensureProgressionSession(supabase)
      const next = await loadProgressionConversation(supabase)
      if (cancelled) return
      applySnapshot(next)
    }

    void loadInitialConversation().catch(() => {
      if (!cancelled) {
        setLoadError(true)
        setLoading(false)
        onConversationInputModeChange?.(false)
      }
    })
    return () => { cancelled = true }
  }, [applySnapshot, onConversationInputModeChange, playerId])

  useEffect(() => {
    return () => onConversationInputModeChange?.(false)
  }, [onConversationInputModeChange])

  useEffect(() => {
    const state = snapshot?.session?.state
    if (!state || !stateNeedsFocus(state)) return
    const timer = window.setInterval(() => { void reload().catch(() => {}) }, 3000)
    return () => window.clearInterval(timer)
  }, [reload, snapshot?.session?.state])

  const session = snapshot?.session ?? null
  const workerStep = typeof session?.metadata.workerStep === 'string' ? session.metadata.workerStep : ''
  const copy = session
    ? workerStep === 'quest_generation' || workerStep === 'quest_repair'
      ? { eyebrow: 'SYSTEM · PREPARING QUEST', title: 'Next move udah kepilih. Gue lagi bikin quest-nya jelas dan executable.' }
      : STATE_COPY[session.state]
    : null
  const waitingForDailyContext = session?.state === 'waiting' && session.metadata.reason === 'daily_context'
  const hideTodayBody = Boolean(session && stateNeedsFocus(session.state))
  const headerStatus = (copy?.eyebrow ?? 'SYSTEM · PROGRESSION').replace('SYSTEM · ', '')
  const systemWorking = Boolean(
    session
      && !snapshot?.question
      && (stateIsWorking(session.state) || workerStep === 'quest_generation' || workerStep === 'quest_repair'),
  )

  if (loading) return <>{children}</>

  return (
    <>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '0 18px', fontFamily: '"IBM Plex Sans", sans-serif' }}>
        <ConversationHeader
          playerName={username}
          statusLabel={headerStatus}
          agentActive={systemWorking}
          action={(
            <Link
              href={`/${encodeURIComponent(username)}/history/sessions`}
              aria-label="Buka riwayat progression"
              style={{ width: 30, height: 30, display: 'grid', placeItems: 'center', border: `1px solid ${S.line}`, borderRadius: 999, color: S.muted, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 13 }}
            >
              ⋯
            </Link>
          )}
        />

        <section style={{ borderBottom: `1px solid ${S.line}`, padding: '14px 0 22px' }}>
          {session ? (
            <div style={{ margin: '0 0 16px', textAlign: 'center', color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8, fontWeight: 700, letterSpacing: '.07em' }}>
              {session.title.toUpperCase()}
            </div>
          ) : null}

          {loadError ? (
            <div style={{ marginTop: 13, color: S.muted, fontSize: 12.5 }}>Timeline belum kebaca. Today tetap bisa dipakai.</div>
          ) : session ? (
            <div>
              {session.kind === 'initial_calibration' && (snapshot?.initialAnswers.length ?? 0) > 0 && (
                <details style={{ border: `1px solid ${S.line}`, borderRadius: 14, background: S.panel2, padding: '11px 12px', marginBottom: 16 }}>
                  <summary style={{ cursor: 'pointer', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, letterSpacing: '.05em' }}>
                    KONTEKS AWAL · {snapshot!.initialAnswers.length} JAWABAN
                  </summary>
                  <div data-conversation-thread="onboarding-context" style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 14 }}>
                    {snapshot!.initialAnswers.map(item => (
                      <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <ConversationBubble actor="system" compact playerName={username}>{item.prompt}</ConversationBubble>
                        <ConversationBubble actor="player" compact playerName={username}>{item.answer}</ConversationBubble>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div data-conversation-thread="progression" style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: snapshot?.question ? 24 : 0 }}>
                {(snapshot?.messages ?? []).map(message => (
                  <ConversationBubble
                    key={message.id}
                    actor={message.actor}
                    playerName={username}
                    meta={message.createdAt ? formatMoment(message.createdAt) : undefined}
                  >
                    {message.body}
                  </ConversationBubble>
                ))}

                {snapshot?.question && (
                  <QuestionComposer
                    key={snapshot.question.id}
                    question={snapshot.question}
                    playerId={playerId}
                    playerName={username}
                    onAnswered={reload}
                  />
                )}

                {systemWorking && copy && (
                  <ConversationBubble actor="system" playerName={username} collapsible={false} systemActive>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <AgentTypingIndicator label="Superhuman sedang memproses next move" />
                      <span style={{ color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.1, fontWeight: 700, letterSpacing: '.05em' }}>{headerStatus}</span>
                    </div>
                    <div style={{ marginTop: 8, color: S.muted, fontSize: 12.5, lineHeight: 1.55 }}>{copy.title}</div>
                  </ConversationBubble>
                )}

                {waitingForDailyContext && (
                  <ConversationBubble actor="system" playerName={username}>
                    Kasih kondisi hari ini di bawah. Setelah itu gue lanjut research dan nentuin arahnya.
                  </ConversationBubble>
                )}
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {hideTodayBody ? (
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '24px 18px 180px', color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, letterSpacing: '.08em' }}>
          {session?.state === 'need_clarification' ? 'GILIRAN LO' : 'SYSTEM YANG LANJUT'}
        </div>
      ) : children}
    </>
  )
}

function QuestionComposer({
  question,
  playerId,
  playerName,
  onAnswered,
}: {
  question: ProgressionConversationQuestion
  playerId: string
  playerName: string
  onAnswered: () => Promise<unknown>
}) {
  const [text, setText] = useState('')
  const [single, setSingle] = useState('')
  const [multi, setMulti] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const textQuestion = question.responseType === 'free_text' || question.responseType === 'short_text'
  const maxTextLength = question.responseType === 'short_text' ? 800 : 5000
  const answer = useMemo(() => {
    if (question.responseType === 'single_choice') return single
    if (question.responseType === 'multiple_choice') return multi
    return text.trim()
  }, [multi, question.responseType, single, text])
  const canSend = Array.isArray(answer) ? answer.length > 0 : Boolean(answer)

  async function submit() {
    if (!canSend || saving) return
    setSaving(true)
    setError(null)
    try {
      await answerProgressionQuestion(supabase, question.id, answer)
      setText('')
      setSingle('')
      setMulti([])
      await onAnswered()
    } catch {
      setError('Jawabannya belum kesimpan. Coba lagi.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-conversation-question style={{ display: 'contents' }}>
      <ConversationBubble actor="system" playerName={playerName} meta={question.createdAt ? formatMoment(question.createdAt) : undefined} collapsible={false}>
        <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 16.5, fontWeight: 650, lineHeight: 1.4 }}>{question.prompt}</div>
        {question.reason && <div style={{ marginTop: 7, color: S.muted, fontSize: 11.5, lineHeight: 1.5 }}>{question.reason}</div>}
      </ConversationBubble>

      <div data-sticky-chat-composer style={{ width: '100%', marginTop: 2 }}>
        <section style={{ width: '100%', boxSizing: 'border-box', padding: '0 0 8px' }}>
          <div style={{ border: `1px solid ${S.line}`, borderRadius: 16, background: 'rgba(16,20,27,.98)', padding: '10px', boxShadow: '0 12px 34px rgba(0,0,0,.22)', backdropFilter: 'blur(18px)' }}>
            <div style={{ margin: '1px 4px 8px', color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, fontWeight: 700, letterSpacing: '.08em' }}>
              BALAS PERTANYAAN SYSTEM
            </div>

            {textQuestion && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                <textarea
                  value={text}
                  onChange={event => setText(event.target.value)}
                  rows={question.responseType === 'short_text' ? 1 : 2}
                  maxLength={maxTextLength}
                  placeholder="Tulis jawaban lo…"
                  autoFocus
                  style={{ flex: 1, minWidth: 0, minHeight: 48, maxHeight: 132, boxSizing: 'border-box', resize: 'none', border: 0, background: 'transparent', color: S.ink, padding: '8px 5px', outline: 'none', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 16, lineHeight: 1.45 }}
                />
                <ProgressionVoiceAnswerRecorder
                  playerId={playerId}
                  questionId={question.id}
                  disabled={saving}
                  textPresent={Boolean(text.trim())}
                  onAnswered={onAnswered}
                />
              </div>
            )}

            {question.responseType === 'single_choice' && (
              <div style={{ display: 'grid', gap: 7 }}>
                {question.options.map(option => (
                  <button key={option} type="button" onClick={() => setSingle(option)} style={{ textAlign: 'left', minHeight: 44, borderRadius: 10, border: `1px solid ${single === option ? S.amber : S.line}`, background: single === option ? 'rgba(246,178,75,.08)' : '#0d1117', color: S.ink, padding: '9px 10px', cursor: 'pointer' }}>
                    {option}
                  </button>
                ))}
              </div>
            )}

            {question.responseType === 'multiple_choice' && (
              <div style={{ display: 'grid', gap: 7 }}>
                {question.options.map(option => {
                  const selected = multi.includes(option)
                  return (
                    <button key={option} type="button" onClick={() => setMulti(current => selected ? current.filter(item => item !== option) : [...current, option])} style={{ textAlign: 'left', minHeight: 44, borderRadius: 10, border: `1px solid ${selected ? S.amber : S.line}`, background: selected ? 'rgba(246,178,75,.08)' : '#0d1117', color: S.ink, padding: '9px 10px', cursor: 'pointer' }}>
                      {selected ? '✓ ' : ''}{option}
                    </button>
                  )
                })}
              </div>
            )}

            {error && <div role="status" style={{ marginTop: 8, color: S.red, fontSize: 11 }}>{error}</div>}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 9 }}>
              <div style={{ minWidth: 0, color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8, letterSpacing: '.06em', overflow: 'hidden', textOverflow: 'ellipsis' }}>{playerName.toUpperCase()}</div>
              <button type="button" onClick={() => { void submit() }} disabled={!canSend || saving} style={{ minHeight: 44, flexShrink: 0, border: 0, borderRadius: 11, background: canSend && !saving ? S.amber : '#262a31', color: canSend && !saving ? '#17120a' : S.muted2, padding: '0 16px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, letterSpacing: '.07em', cursor: canSend && !saving ? 'pointer' : 'default' }}>
                {saving ? 'NYIMPEN…' : 'KIRIM →'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
