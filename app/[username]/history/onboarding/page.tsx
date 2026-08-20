'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  loadInitializationHistoryAnswers,
  updateInitializationVoiceTranscript,
  type InitializationHistoryAnswer,
} from '@/lib/player-initialization-voice-service'
import { supabase } from '@/lib/supabase'

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

function formatDuration(ms: number | null) {
  if (!ms) return null
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function OnboardingHistoryPage() {
  const params = useParams<{ username: string }>()
  const username = decodeURIComponent(String(params.username))
  const [answers, setAnswers] = useState<InitializationHistoryAnswer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const { data: authData, error: authError } = await supabase.auth.getUser()
    if (authError || !authData.user) throw new Error('Player session is not available.')
    const rows = await loadInitializationHistoryAnswers(supabase, authData.user.id)
    setAnswers(rows)
  }, [])

  useEffect(() => {
    let cancelled = false
    void load()
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Player origin could not load.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [load])

  async function saveTranscript(answer: InitializationHistoryAnswer) {
    if (saving || !draft.trim()) return
    setSaving(true)
    setError(null)
    try {
      await updateInitializationVoiceTranscript(supabase, answer.id, draft)
      await load()
      setEditingId(null)
      setDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Transcript correction could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 72 }}>
      <main style={{ width: '100%', maxWidth: 640, margin: '0 auto', padding: '29px 18px 0' }}>
        <Link href={`/${encodeURIComponent(username)}/history`} style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, color: S.muted, textDecoration: 'none' }}>← PROGRESSION</Link>
        <div style={{ marginTop: 20, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: S.amber, letterSpacing: '.16em', fontWeight: 700 }}>PLAYER ORIGIN</div>
        <h1 style={{ margin: '8px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(30px,8vw,42px)', lineHeight: 1, letterSpacing: '-.04em' }}>What you told the System.</h1>
        <p style={{ margin: '11px 0 0', color: S.muted, fontSize: 12.5, lineHeight: 1.6, maxWidth: 540 }}>
          Your initialization answers are the starting evidence behind the Player Brief. Voice answers become text here after the calibration cycle understands the raw audio.
        </p>

        {loading ? (
          <div style={{ marginTop: 30, color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>LOADING PLAYER ORIGIN…</div>
        ) : answers.length === 0 ? (
          <section style={{ marginTop: 28, border: `1px solid ${S.line}`, borderRadius: 16, background: S.panel, padding: 17 }}>
            <div style={{ color: S.muted, fontSize: 12.5, lineHeight: 1.6 }}>No initialization answers are recorded for this player yet.</div>
          </section>
        ) : (
          <div style={{ marginTop: 28, display: 'grid', gap: 12 }}>
            {answers.map((answer, index) => {
              const editing = editingId === answer.id
              const duration = formatDuration(answer.durationMs)
              return (
                <section key={answer.id} style={{ border: `1px solid ${editing ? S.lineStrong : S.line}`, borderRadius: 17, background: S.panel, padding: '16px 15px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.muted2, letterSpacing: '.1em' }}>QUESTION {index + 1} · {answer.origin === 'adaptive' ? 'SYSTEM FOLLOW-UP' : 'BASE CONTEXT'}</div>
                    <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: answer.answerMode === 'audio' ? S.gold : S.muted, letterSpacing: '.08em' }}>
                      {answer.answerMode === 'audio' ? `VOICE → TRANSCRIPT${duration ? ` · ${duration}` : ''}` : 'TEXT ANSWER'}
                    </div>
                  </div>
                  <div style={{ marginTop: 8, fontFamily: '"Space Grotesk", sans-serif', fontSize: 17, lineHeight: 1.3, fontWeight: 650 }}>{answer.prompt}</div>

                  {editing ? (
                    <div style={{ marginTop: 13 }}>
                      <textarea
                        value={draft}
                        onChange={event => setDraft(event.target.value)}
                        rows={6}
                        maxLength={12000}
                        disabled={saving}
                        style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 132, border: `1px solid ${S.lineStrong}`, borderRadius: 12, background: S.panel2, color: S.ink, padding: '12px 13px', outline: 'none', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 13, lineHeight: 1.6 }}
                      />
                      <div style={{ marginTop: 9, display: 'flex', gap: 8 }}>
                        <button type="button" onClick={() => { void saveTranscript(answer) }} disabled={saving || !draft.trim()} style={{ minHeight: 38, border: 0, borderRadius: 10, padding: '0 13px', background: saving || !draft.trim() ? '#2a2f37' : S.amber, color: saving || !draft.trim() ? S.muted2 : '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, cursor: saving || !draft.trim() ? 'default' : 'pointer' }}>{saving ? 'SAVING…' : 'SAVE CORRECTION'}</button>
                        <button type="button" onClick={() => { setEditingId(null); setDraft('') }} disabled={saving} style={{ minHeight: 38, border: `1px solid ${S.line}`, borderRadius: 10, padding: '0 12px', background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: saving ? 'default' : 'pointer' }}>CANCEL</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ marginTop: 11, color: answer.answerText ? S.ink : S.muted2, fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
                        {answer.answerText ?? (answer.answerMode === 'audio' ? 'Transcript will appear after the System finishes the calibration cycle.' : 'No answer text available.')}
                      </div>
                      {answer.answerMode === 'audio' && answer.answerText && (
                        <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={() => { setEditingId(answer.id); setDraft(answer.answerText ?? '') }}
                            style={{ minHeight: 34, border: `1px solid ${S.line}`, borderRadius: 9, padding: '0 11px', background: 'transparent', color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: 'pointer' }}
                          >
                            EDIT TRANSCRIPT
                          </button>
                          {answer.transcriptEditedByPlayer && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.amber, letterSpacing: '.07em' }}>PLAYER CORRECTED</span>}
                        </div>
                      )}
                    </>
                  )}
                </section>
              )
            })}
          </div>
        )}

        <div style={{ marginTop: 18, padding: '12px 13px', border: `1px solid ${S.line}`, borderRadius: 13, background: S.panel2, color: S.muted2, fontSize: 10.5, lineHeight: 1.55 }}>
          Correcting a voice transcript does not delete the original raw audio. The correction is saved as new player evidence so future reasoning can use the player-confirmed wording.
        </div>
        {error && <div role="alert" style={{ marginTop: 13, padding: '11px 12px', border: '1px solid #482631', borderRadius: 12, background: '#171116', color: S.red, fontSize: 11.5, lineHeight: 1.5 }}>{error}</div>}
      </main>
    </div>
  )
}
