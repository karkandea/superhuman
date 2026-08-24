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
import ConversationBubble, { ConversationStatus } from './conversation-bubble'
import ConversationHeader from './conversation-header'

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

  if (loading) return <>{children}</>

  return (
    <>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '0 18px', fontFamily: '"IBM Plex Sans", sans-serif' }}>
        <ConversationHeader
          playerName={username}
          statusLabel={headerStatus}
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
                        <ConversationBubble actor="system" compact>{item.prompt}</ConversationBubble>
                        <ConversationBubble actor="player" compact>{item.answer}</ConversationBubble>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div data-conversation-thread="progression" style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: snapshot?.question ? 110 : 0 }}>
                {(snapshot?.messages ?? []).map(message => (
                  <ConversationBubble
                    key={message.id}
                    actor={message.actor}
                    meta={message.createdAt ? formatMoment(message.createdAt) : undefined}
                  >
                    {message.body}
                  </ConversationBubble>
                ))}

                {snapshot?.question && (
                  <QuestionComposer question={snapshot.question} onAnswered={reload} />
                )}

                {!snapshot?.question && copy && stateNeedsFocus(session.state) && (
                  <ConversationStatus>{copy.title}</ConversationStatus>
                )}

                {waitingForDailyContext && (
                  <ConversationBubble actor="system">
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
  onAnswered,
}: {
  question: ProgressionConversationQuestion
  onAnswered: () => Promise<unknown>
}) {
  const [text, setText] = useState('')
  const [single, setSingle] = useState('')
  const [multi, setMulti] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      <ConversationBubble actor="system" meta={question.createdAt ? formatMoment(question.createdAt) : undefined} collapsible={false}>
        <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 16.5, fontWeight: 650, lineHeight: 1.4 }}>{question.prompt}</div>
        {question.reason && <div style={{ marginTop: 7, color: S.muted, fontSize: 11.5, lineHeight: 1.5 }}>{question.reason}</div>}
      </ConversationBubble>

      <div
        data-sticky-chat-composer
        style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(62px + env(safe-area-inset-bottom))', zIndex: 56, pointerEvents: 'none', background: 'linear-gradient(180deg, transparent, rgba(12,15,20,.96) 22%)', paddingTop: 18 }}
      >
        <section style={{ width: 'min(680px, 100%)', margin: '0 auto', boxSizing: 'border-box', padding: '0 12px 10px', pointerEvents: 'auto' }}>
          <div style={{ maxHeight: '45dvh', overflowY: 'auto', border: `1px solid ${S.line}`, borderRadius: 16, background: 'rgba(16,20,27,.98)', padding: '10px', boxShadow: '0 -14px 42px rgba(0,0,0,.3)', backdropFilter: 'blur(18px)' }}>
            {(question.responseType === 'free_text' || question.responseType === 'short_text') && (
              <textarea
                value={text}
                onChange={event => setText(event.target.value)}
                rows={question.responseType === 'short_text' ? 1 : 2}
                maxLength={question.responseType === 'short_text' ? 800 : 5000}
                placeholder="Balas Superhuman…"
                autoFocus
                style={{ width: '100%', minHeight: 42, maxHeight: 112, boxSizing: 'border-box', resize: 'none', border: 0, background: 'transparent', color: S.ink, padding: '5px 5px 7px', outline: 'none', font: 'inherit', fontSize: 13, lineHeight: 1.5 }}
              />
            )}

            {question.responseType === 'single_choice' && (
              <div style={{ display: 'grid', gap: 7 }}>
                {question.options.map(option => (
                  <button key={option} type="button" onClick={() => setSingle(option)} style={{ textAlign: 'left', minHeight: 40, borderRadius: 10, border: `1px solid ${single === option ? S.amber : S.line}`, background: single === option ? 'rgba(246,178,75,.08)' : '#0d1117', color: S.ink, padding: '8px 10px', cursor: 'pointer' }}>
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
                    <button key={option} type="button" onClick={() => setMulti(current => selected ? current.filter(item => item !== option) : [...current, option])} style={{ textAlign: 'left', minHeight: 40, borderRadius: 10, border: `1px solid ${selected ? S.amber : S.line}`, background: selected ? 'rgba(246,178,75,.08)' : '#0d1117', color: S.ink, padding: '8px 10px', cursor: 'pointer' }}>
                      {selected ? '✓ ' : ''}{option}
                    </button>
                  )
                })}
              </div>
            )}

            {error && <div role="status" style={{ marginTop: 8, color: S.red, fontSize: 11 }}>{error}</div>}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 7 }}>
              <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8, letterSpacing: '.06em' }}>PLAYER</div>
              <button type="button" onClick={() => { void submit() }} disabled={!canSend || saving} style={{ minHeight: 36, border: 0, borderRadius: 10, background: canSend && !saving ? S.amber : '#262a31', color: canSend && !saving ? '#17120a' : S.muted2, padding: '0 14px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, letterSpacing: '.07em', cursor: canSend && !saving ? 'pointer' : 'default' }}>
                {saving ? 'NYIMPEN…' : 'KIRIM →'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
