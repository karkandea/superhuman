'use client'

import { useRef, useState, type FormEvent } from 'react'
import { submitDailyContext } from '@/lib/daily-context-service'
import { DAILY_CONTEXT_MAX_BYTES, dailyContextSummary, type DailyContextSnapshot } from '@/lib/daily-context'
import { supabase } from '@/lib/supabase'

const S = {
  panel: '#13171f', panel2: '#10141b', input: '#0f1319', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a', bg: '#0c0f14',
} as const

function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

export default function DailyContextCheckin({
  date,
  context,
  generationBusy,
  onConfirmed,
}: {
  date: string
  context: DailyContextSnapshot | null
  generationBusy: boolean
  onConfirmed: (context: DailyContextSnapshot) => void | Promise<void>
}) {
  const [telling, setTelling] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardRef = useRef(false)

  async function persist(mode: 'normal' | 'context') {
    if (guardRef.current || saving) return
    guardRef.current = true
    setSaving(true)
    setError(null)
    try {
      const saved = await submitDailyContext(supabase, date, { mode, text: mode === 'context' ? text : '' })
      await onConfirmed(saved)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save today context')
    } finally {
      setSaving(false)
      guardRef.current = false
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void persist('context')
  }

  if (context) {
    return (
      <section aria-label="Daily Context confirmed" style={{ border: `1px solid ${S.line}`, borderRadius: 17, background: S.panel, padding: '16px 15px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.amber, fontWeight: 700, letterSpacing: '.14em' }}>TODAY CONTEXT SAVED</div>
          {generationBusy && <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.gold }}>SYSTEM WORKING…</div>}
        </div>
        <div style={{ marginTop: 8, color: S.ink, fontSize: 13, lineHeight: 1.5 }}>{dailyContextSummary(context)}</div>
        <div style={{ marginTop: 7, color: S.muted2, fontSize: 10.5, lineHeight: 1.45 }}>
          This only guides today’s first quest selection. New changes after quests appear go through Update System and explicit interrupts.
        </div>
      </section>
    )
  }

  return (
    <section aria-label="System check-in" style={{ border: `1px solid ${telling ? '#413821' : S.line}`, borderRadius: 18, background: 'linear-gradient(145deg,#15140f,#11161e)', padding: '17px 15px' }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.amber, fontWeight: 700, letterSpacing: '.16em' }}>SYSTEM CHECK-IN</div>
      <h2 style={{ margin: '7px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 20, lineHeight: 1.18, letterSpacing: '-.025em' }}>Anything today that should affect your quests?</h2>
      <p style={{ margin: '8px 0 0', color: S.muted, fontSize: 12, lineHeight: 1.55 }}>
        Tell the System only what it cannot observe — unusual time limits, health, travel, commitments, location, or capacity. No schedule form needed.
      </p>

      {!telling ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 9, marginTop: 14 }}>
          <button
            type="button"
            disabled={saving}
            onClick={() => { void persist('normal') }}
            style={{ minHeight: 46, border: 'none', borderRadius: 11, background: saving ? '#3a3328' : S.amber, color: saving ? S.muted : S.bg, padding: '0 12px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, letterSpacing: '.05em', cursor: saving ? 'default' : 'pointer' }}
          >
            {saving ? 'SAVING…' : 'NO, NORMAL DAY'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => { setTelling(true); setError(null) }}
            style={{ minHeight: 46, border: `1px solid ${S.lineStrong}`, borderRadius: 11, background: S.input, color: S.gold, padding: '0 12px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, letterSpacing: '.05em', cursor: saving ? 'default' : 'pointer' }}
          >
            TELL SYSTEM…
          </button>
        </div>
      ) : (
        <form onSubmit={submit} style={{ marginTop: 14 }}>
          <label htmlFor="daily-context-text" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>What is different today?</label>
          <textarea
            id="daily-context-text"
            autoFocus
            value={text}
            onChange={(event) => { setText(event.target.value); setError(null) }}
            disabled={saving}
            rows={4}
            placeholder="e.g. Meeting 09:00–17:00, family dinner tonight. I only have a little time before work and after 20:00."
            style={{ boxSizing: 'border-box', width: '100%', minHeight: 112, maxHeight: 240, resize: 'vertical', border: `1px solid ${S.lineStrong}`, borderRadius: 11, outline: 'none', background: S.input, color: S.ink, padding: '11px 12px', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 16, lineHeight: 1.5 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 9, marginTop: 9, flexWrap: 'wrap' }}>
            <div style={{ color: bytes(text) > DAILY_CONTEXT_MAX_BYTES ? S.red : S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>
              {Math.ceil(bytes(text) / 1024)} / {DAILY_CONTEXT_MAX_BYTES / 1024} KB
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" disabled={saving} onClick={() => { setTelling(false); setText(''); setError(null) }} style={{ minHeight: 42, border: `1px solid ${S.line}`, borderRadius: 10, background: 'transparent', color: S.muted, padding: '0 12px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: saving ? 'default' : 'pointer' }}>CANCEL</button>
              <button type="submit" disabled={saving || !text.trim() || bytes(text) > DAILY_CONTEXT_MAX_BYTES} style={{ minHeight: 42, border: 'none', borderRadius: 10, background: saving || !text.trim() || bytes(text) > DAILY_CONTEXT_MAX_BYTES ? '#3a3328' : S.amber, color: saving || !text.trim() || bytes(text) > DAILY_CONTEXT_MAX_BYTES ? S.muted : S.bg, padding: '0 13px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, letterSpacing: '.05em', cursor: saving ? 'default' : 'pointer' }}>{saving ? 'SAVING…' : 'USE TODAY CONTEXT'}</button>
            </div>
          </div>
        </form>
      )}

      {error && <div role="alert" style={{ marginTop: 9, border: '1px solid #4b2730', borderRadius: 10, background: '#181014', padding: '9px 10px', color: S.red, fontSize: 11, lineHeight: 1.45 }}>{error}</div>}
    </section>
  )
}
