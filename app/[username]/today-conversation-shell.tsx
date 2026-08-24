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
}: {
  playerId: string
  username: string
  children: ReactNode
}) {
  const [snapshot, setSnapshot] = useState<ProgressionConversationSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const reload = useCallback(async () => {
    await ensureProgressionSession(supabase)
    const next = await loadProgressionConversation(supabase)
    setSnapshot(next)
    setLoadError(false)
    setLoading(false)
    return next
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadInitialConversation() {
      await ensureProgressionSession(supabase)
      const next = await loadProgressionConversation(supabase)
      if (cancelled) return
      setSnapshot(next)
      setLoadError(false)
      setLoading(false)
    }

    void loadInitialConversation().catch(() => {
      if (!cancelled) {
        setLoadError(true)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [playerId])

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

  if (loading) return <>{children}</>

  return (
    <>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '18px 18px 0', fontFamily: '"IBM Plex Sans", sans-serif' }}>
        <section style={{ borderBottom: `1px solid ${S.line}`, padding: '10px 0 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
            <div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.14em' }}>
                {copy?.eyebrow ?? 'SYSTEM · PROGRESSION'}
              </div>
              <h2 style={{ margin: '7px 0 0', color: S.ink, fontFamily: '"Space Grotesk", sans-serif', fontSize: 20, lineHeight: 1.18, letterSpacing: '-.025em' }}>
                {session?.title ?? 'Progression'}
              </h2>
            </div>
            <Link
              href={`/${encodeURIComponent(username)}/history/sessions`}
              style={{ color: S.muted, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.2, fontWeight: 700 }}
            >
              RIWAYAT →
            </Link>
          </div>

          {loadError ? (
            <div style={{ marginTop: 13, color: S.muted, fontSize: 12.5 }}>Timeline belum kebaca. Today tetap bisa dipakai.</div>
          ) : session ? (
            <div style={{ marginTop: 16 }}>
              {session.kind === 'initial_calibration' && (snapshot?.initialAnswers.length ?? 0) > 0 && (
                <details style={{ border: `1px solid ${S.line}`, borderRadius: 13, background: S.panel2, padding: '12px 13px', marginBottom: 13 }}>
                  <summary style={{ cursor: 'pointer', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, letterSpacing: '.04em' }}>
                    PLAYER · JAWABAN ONBOARDING ({snapshot!.initialAnswers.length})
                  </summary>
                  <div style={{ display: 'grid', gap: 12, marginTop: 13 }}>
                    {snapshot!.initialAnswers.map(item => (
                      <div key={item.id}>
                        <div style={{ color: S.muted2, fontSize: 10.5, lineHeight: 1.45 }}>{item.prompt}</div>
                        <div style={{ color: S.ink, fontSize: 12.5, lineHeight: 1.55, marginTop: 3, whiteSpace: 'pre-wrap' }}>{item.answer}</div>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div style={{ display: 'grid', gap: 10 }}>
                {(snapshot?.messages ?? []).map(message => (
                  <article
                    key={message.id}
                    style={{
                      marginLeft: message.actor === 'player' ? '12%' : 0,
                      marginRight: message.actor === 'system' ? '8%' : 0,
                      borderLeft: message.actor === 'system' ? `2px solid ${S.amber}` : `1px solid ${S.line}`,
                      padding: message.actor === 'system' ? '3px 0 3px 12px' : '8px 10px',
                      borderRadius: message.actor === 'player' ? 10 : 0,
                      background: message.actor === 'player' ? S.panel2 : 'transparent',
                    }}
                  >
                    <div style={{ color: message.actor === 'system' ? S.gold : S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8, fontWeight: 700, letterSpacing: '.08em' }}>
                      {message.actor === 'system' ? 'SYSTEM' : 'PLAYER'}{message.createdAt ? ` · ${formatMoment(message.createdAt)}` : ''}
                    </div>
                    <div style={{ marginTop: 4, color: S.ink, fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{message.body}</div>
                  </article>
                ))}
              </div>

              {snapshot?.question && (
                <QuestionCard question={snapshot.question} onAnswered={reload} />
              )}

              {!snapshot?.question && copy && stateNeedsFocus(session.state) && (
                <div aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 15, color: S.muted, fontSize: 11.8 }}>
                  <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 99, background: S.amber, boxShadow: '0 0 12px rgba(246,178,75,.55)' }} />
                  {copy.title}
                </div>
              )}

              {waitingForDailyContext && (
                <div style={{ marginTop: 14, color: S.muted, fontSize: 11.8, lineHeight: 1.55 }}>
                  Kasih kondisi hari ini di bawah. Setelah itu System yang lanjut research dan nentuin arahnya.
                </div>
              )}
            </div>
          ) : null}
        </section>
      </div>

      {hideTodayBody ? (
        <div style={{ maxWidth: 620, margin: '0 auto', padding: '26px 18px 180px', color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, letterSpacing: '.08em' }}>
          {session?.state === 'need_clarification' ? 'GILIRAN LO' : 'SYSTEM YANG LANJUT'}
        </div>
      ) : children}
    </>
  )
}

function QuestionCard({
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
    <section style={{ marginTop: 17, border: `1px solid ${S.line}`, borderRadius: 16, background: S.panel, padding: '14px 13px' }}>
      <div style={{ color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, fontWeight: 700, letterSpacing: '.1em' }}>SYSTEM NANYA</div>
      <div style={{ marginTop: 8, color: S.ink, fontFamily: '"Space Grotesk", sans-serif', fontSize: 18, fontWeight: 650, lineHeight: 1.35 }}>{question.prompt}</div>

      {(question.responseType === 'free_text' || question.responseType === 'short_text') && (
        <textarea
          value={text}
          onChange={event => setText(event.target.value)}
          rows={question.responseType === 'short_text' ? 2 : 4}
          maxLength={question.responseType === 'short_text' ? 800 : 5000}
          placeholder="Jawab pakai bahasa lo sendiri…"
          style={{ width: '100%', marginTop: 13, boxSizing: 'border-box', resize: 'vertical', border: `1px solid ${S.line}`, borderRadius: 11, background: '#0d1117', color: S.ink, padding: '11px 12px', outline: 'none', font: 'inherit', fontSize: 13, lineHeight: 1.5 }}
        />
      )}

      {question.responseType === 'single_choice' && (
        <div style={{ display: 'grid', gap: 8, marginTop: 13 }}>
          {question.options.map(option => (
            <button key={option} type="button" onClick={() => setSingle(option)} style={{ textAlign: 'left', minHeight: 42, borderRadius: 11, border: `1px solid ${single === option ? S.amber : S.line}`, background: single === option ? 'rgba(246,178,75,.08)' : '#0d1117', color: S.ink, padding: '9px 11px', cursor: 'pointer' }}>
              {option}
            </button>
          ))}
        </div>
      )}

      {question.responseType === 'multiple_choice' && (
        <div style={{ display: 'grid', gap: 8, marginTop: 13 }}>
          {question.options.map(option => {
            const selected = multi.includes(option)
            return (
              <button key={option} type="button" onClick={() => setMulti(current => selected ? current.filter(item => item !== option) : [...current, option])} style={{ textAlign: 'left', minHeight: 42, borderRadius: 11, border: `1px solid ${selected ? S.amber : S.line}`, background: selected ? 'rgba(246,178,75,.08)' : '#0d1117', color: S.ink, padding: '9px 11px', cursor: 'pointer' }}>
                {selected ? '✓ ' : ''}{option}
              </button>
            )
          })}
        </div>
      )}

      {error && <div role="status" style={{ marginTop: 9, color: S.red, fontSize: 11 }}>{error}</div>}
      <button type="button" onClick={() => { void submit() }} disabled={!canSend || saving} style={{ width: '100%', minHeight: 44, marginTop: 12, border: 0, borderRadius: 11, background: canSend && !saving ? S.amber : '#262a31', color: canSend && !saving ? '#17120a' : S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 800, letterSpacing: '.07em', cursor: canSend && !saving ? 'pointer' : 'default' }}>
        {saving ? 'NYIMPEN…' : 'JAWAB →'}
      </button>
    </section>
  )
}
