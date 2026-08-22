'use client'

import { useRef, useState, type FormEvent } from 'react'
import { submitDailyContext } from '@/lib/daily-context-service'
import { DAILY_CONTEXT_MAX_BYTES, type DailyContextSnapshot } from '@/lib/daily-context'
import { supabase } from '@/lib/supabase'

const S = {
  panel: '#13171f', input: '#0f1319', line: '#232a35', lineStrong: '#303946',
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
    if (guardRef.current || saving || generationBusy) return
    guardRef.current = true
    setSaving(true)
    setError(null)
    try {
      const saved = await submitDailyContext(supabase, date, { mode, text: mode === 'context' ? text : '' })
      await onConfirmed(saved)
    } catch {
      setError('Belum kesimpan. Coba sekali lagi.')
    } finally {
      setSaving(false)
      guardRef.current = false
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void persist('context')
  }

  if (context) return null

  return (
    <section aria-label="Today check-in" style={{ border: `1px solid ${telling ? '#413821' : S.line}`, borderRadius: 18, background: 'linear-gradient(145deg,#15140f,#11161e)', padding: '18px 16px' }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.amber, fontWeight: 700, letterSpacing: '.14em' }}>TODAY</div>
      <h2 style={{ margin: '7px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 21, lineHeight: 1.18, letterSpacing: '-.025em' }}>Ada yang beda hari ini?</h2>
      <p style={{ margin: '7px 0 0', color: S.muted, fontSize: 12, lineHeight: 1.5 }}>Kalau ada yang bikin waktu, tenaga, atau prioritas berubah, kasih tahu.</p>

      {!telling ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 9, marginTop: 14 }}>
          <button
            type="button"
            disabled={saving || generationBusy}
            onClick={() => { void persist('normal') }}
            style={{ minHeight: 45, border: 'none', borderRadius: 11, background: saving ? '#3a3328' : S.amber, color: saving ? S.muted : S.bg, padding: '0 12px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, cursor: saving ? 'default' : 'pointer' }}
          >
            {saving ? 'NYIMPEN…' : 'NGGAK ADA'}
          </button>
          <button
            type="button"
            disabled={saving || generationBusy}
            onClick={() => { setTelling(true); setError(null) }}
            style={{ minHeight: 45, border: `1px solid ${S.lineStrong}`, borderRadius: 11, background: S.input, color: S.gold, padding: '0 12px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, cursor: saving ? 'default' : 'pointer' }}
          >
            ADA
          </button>
        </div>
      ) : (
        <form onSubmit={submit} style={{ marginTop: 14 }}>
          <label htmlFor="daily-context-text" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>Apa yang beda hari ini?</label>
          <textarea
            id="daily-context-text"
            autoFocus
            value={text}
            onChange={(event) => { setText(event.target.value); setError(null) }}
            disabled={saving || generationBusy}
            rows={3}
            placeholder="Meeting pindah, badan lagi drop, cuma punya 30 menit…"
            style={{ boxSizing: 'border-box', width: '100%', minHeight: 96, maxHeight: 220, resize: 'vertical', border: `1px solid ${S.lineStrong}`, borderRadius: 11, outline: 'none', background: S.input, color: S.ink, padding: '11px 12px', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 15.5, lineHeight: 1.5 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 9 }}>
            <button type="button" disabled={saving} onClick={() => { setTelling(false); setText(''); setError(null) }} style={{ minHeight: 39, border: 0, background: 'transparent', color: S.muted, padding: '0 10px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: 'pointer' }}>BATAL</button>
            <button type="submit" disabled={saving || generationBusy || !text.trim() || bytes(text) > DAILY_CONTEXT_MAX_BYTES} style={{ minHeight: 39, border: 'none', borderRadius: 10, background: saving || !text.trim() || bytes(text) > DAILY_CONTEXT_MAX_BYTES ? '#3a3328' : S.amber, color: saving || !text.trim() || bytes(text) > DAILY_CONTEXT_MAX_BYTES ? S.muted : S.bg, padding: '0 13px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: saving ? 'default' : 'pointer' }}>{saving ? 'NYIMPEN…' : 'LANJUT'}</button>
          </div>
        </form>
      )}

      {error && <div role="alert" style={{ marginTop: 9, color: S.red, fontSize: 11, lineHeight: 1.45 }}>{error}</div>}
    </section>
  )
}
