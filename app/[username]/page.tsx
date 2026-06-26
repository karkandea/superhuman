'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { DATA, TOTAL, ANCHOR_IDS, todayStr, toDateStr } from '@/lib/checklist-data'

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', gold: '#ffd488',
} as const

function computeStreak(logs: { date: string; checked_ids: string[] }[]) {
  const qualSet = new Set(
    logs.filter(l => ANCHOR_IDS.every(a => l.checked_ids.includes(a))).map(l => l.date)
  )
  let n = 0
  const cur = new Date()
  if (!qualSet.has(toDateStr(cur))) cur.setDate(cur.getDate() - 1)
  while (qualSet.has(toDateStr(cur))) { n++; cur.setDate(cur.getDate() - 1) }
  return n
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every(x => b.includes(x))

export default function ChecklistPage() {
  const params   = useParams()
  const router   = useRouter()
  const username = decodeURIComponent(params.username as string)

  const [userId,  setUserId]  = useState<string | null>(null)
  const [checked, setChecked] = useState<string[]>([])
  const [streak,  setStreak]  = useState(0)
  const [loading, setLoading] = useState(true)
  const [status,  setStatus]  = useState<'idle' | 'saving' | 'saved'>('idle')

  const checkedRef = useRef<string[]>([])
  const saveTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  checkedRef.current = checked

  const refreshStreak = useCallback(async (uid: string) => {
    const from60 = toDateStr(new Date(Date.now() - 60 * 864e5))
    const { data } = await supabase
      .from('daily_logs').select('date, checked_ids')
      .eq('user_id', uid).gte('date', from60)
    setStreak(computeStreak(data ?? []))
  }, [])

  // initial load + realtime subscribe
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null

    async function init() {
      const { data: user } = await supabase
        .from('users').select('id').eq('name', username).single()
      if (!user) { router.push('/'); return }
      setUserId(user.id)

      const today = todayStr()
      const { data: log } = await supabase
        .from('daily_logs').select('checked_ids')
        .eq('user_id', user.id).eq('date', today).single()

      setChecked(log?.checked_ids ?? [])
      await refreshStreak(user.id)
      setLoading(false)

      // realtime: dengerin perubahan row hari ini dari device manapun
      channel = supabase
        .channel(`logs:${user.id}:${today}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'daily_logs', filter: `user_id=eq.${user.id}` },
          (payload) => {
            const row = payload.new as { date: string; checked_ids: string[] }
            if (row?.date === todayStr()) {
              const incoming = row.checked_ids ?? []
              if (!sameSet(incoming, checkedRef.current)) setChecked(incoming)
            }
          })
        .subscribe()
    }
    init()

    return () => { if (channel) supabase.removeChannel(channel) }
  }, [username, router, refreshStreak])

  // simpen ke DB (debounced)
  const persist = useCallback((next: string[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setStatus('saving')
    saveTimer.current = setTimeout(async () => {
      const uid = userId
      if (!uid) return
      const { error } = await supabase.from('daily_logs').upsert(
        { user_id: uid, date: todayStr(), checked_ids: next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,date' }
      )
      if (!error) {
        setStatus('saved')
        refreshStreak(uid)
        setTimeout(() => setStatus('idle'), 1500)
      } else {
        setStatus('idle')
      }
    }, 500)
  }, [userId, refreshStreak])

  const toggle = useCallback((id: string) => {
    setChecked(prev => {
      const next = prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
      persist(next)
      return next
    })
  }, [persist])

  const resetDay = () => {
    setChecked([])
    persist([])
  }

  const pct         = TOTAL ? Math.round((checked.length / TOTAL) * 100) : 0
  const p           = TOTAL ? checked.length / TOTAL : 0
  const anchorsDone = ANCHOR_IDS.filter(a => checked.includes(a)).length
  const allAnchors  = anchorsDone === ANCHOR_IDS.length

  if (loading) return (
    <div style={{ background: S.bg, minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace' }}>
      loading...
    </div>
  )

  return (
    <div style={{ background: S.bg, minHeight: '100dvh', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 80 }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '0 18px' }}>

        <header style={{ padding: '34px 0 18px', textAlign: 'center' }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, letterSpacing: '.18em', textTransform: 'uppercase', color: S.muted }}>
            SELAMAT PAGI · {username.toUpperCase()}
          </div>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, color: S.muted, opacity: .7, marginTop: 4 }}>
            {new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
          <h1 style={{
            fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, lineHeight: 1.04,
            fontSize: 'clamp(26px,7vw,34px)', margin: '14px 0 2px', letterSpacing: '-.02em',
            color: p > 0.7 ? S.gold : S.ink,
            textShadow: p > 0.7 ? `0 0 ${18 * p}px rgba(255,212,136,${0.55 * p})` : 'none',
            transition: 'color 500ms ease',
          }}>
            Menangin Hari.
            <span style={{ display: 'block', fontSize: 13, fontWeight: 500, letterSpacing: '.02em', color: S.muted, textShadow: 'none', marginTop: 8, fontFamily: '"IBM Plex Sans", sans-serif' }}>
              Subuh bangun, full disiplin. Versi maksimal lo, satu hari kerja.
            </span>
          </h1>

          <div style={{ display: 'flex', gap: 12, margin: '22px 0 6px' }}>
            <div style={{ flex: 1, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: '14px 16px' }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 600, fontSize: 26, color: p > 0.5 ? S.gold : S.ink }}>{pct}%</div>
              <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: S.muted }}>Hari ini</div>
            </div>
            <div style={{ flex: 1, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: '14px 16px' }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 600, fontSize: 26, color: S.amber }}>{streak}</div>
              <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: S.muted }}>Streak hari</div>
            </div>
          </div>

          <div style={{ height: 6, borderRadius: 99, background: '#1c222c', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: `linear-gradient(90deg,${S.amber},${S.gold})`, boxShadow: `0 0 12px rgba(246,178,75,${.6 * p})`, transition: 'width 450ms ease' }} />
          </div>

          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, textAlign: 'center', margin: '14px 0 6px' }}>
            {allAnchors
              ? <span>⚡ <strong style={{ color: S.amber }}>5 jangkar kelar — hari ini lo menang.</strong></span>
              : <span>Jangkar wajib: <strong style={{ color: S.amber }}>{anchorsDone}/{ANCHOR_IDS.length}</strong> kelar buat streak jalan</span>
            }
          </div>

          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, color: status === 'saved' ? S.amber : S.muted, opacity: status === 'idle' ? 0 : .9, height: 14, transition: 'opacity 300ms ease', marginBottom: 6 }}>
            {status === 'saving' ? 'nyimpen…' : status === 'saved' ? '✓ tersimpan, sinkron semua device' : ''}
          </div>

          <Link href={`/${encodeURIComponent(username)}/history`} style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.amber, textDecoration: 'none', letterSpacing: '.08em' }}>
            LIHAT HISTORY →
          </Link>
        </header>

        <main>
          {DATA.map(sec => (
            <section key={sec.title} style={{ marginTop: 26 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 2px 10px' }}>
                <span style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, fontSize: 16 }}>{sec.title}</span>
                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, marginLeft: 'auto' }}>{sec.clock}</span>
              </div>
              <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, overflow: 'hidden' }}>
                {sec.items.map((item, idx) => {
                  const done = checked.includes(item.id)
                  return (
                    <div
                      key={item.id}
                      onClick={() => toggle(item.id)}
                      role="checkbox"
                      aria-checked={done}
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(item.id) } }}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 13,
                        padding: '15px 16px', cursor: 'pointer', userSelect: 'none',
                        borderTop: idx === 0 ? 'none' : `1px solid ${S.line}`,
                        background: done ? 'rgba(246,178,75,0.03)' : 'transparent',
                        transition: 'background 160ms ease',
                      }}
                    >
                      <span style={{
                        flexShrink: 0, width: 22, height: 22, borderRadius: 7, marginTop: 1,
                        display: 'grid', placeItems: 'center', transition: 'all 180ms ease',
                        border: done ? 'none' : '1.6px solid #39414e',
                        background: done ? `linear-gradient(135deg,${S.amber},${S.gold})` : 'transparent',
                        boxShadow: done ? '0 0 14px rgba(246,178,75,.55)' : 'none',
                      }}>
                        {done && (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={S.bg} strokeWidth="3.4">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                      <span style={{ fontSize: 14.5, lineHeight: 1.4, letterSpacing: '.005em', color: done ? S.muted : S.ink }}>
                        {item.label}
                        {item.anchor && (
                          <span style={{
                            display: 'inline-block', fontFamily: '"IBM Plex Mono", monospace',
                            fontSize: 9.5, letterSpacing: '.1em', border: `1px solid rgba(246,178,75,.5)`,
                            color: S.amber, borderRadius: 6, padding: '1px 5px', marginLeft: 7, verticalAlign: '1.5px',
                          }}>WAJIB</span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </main>

        <footer style={{ marginTop: 30, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
          <button
            onClick={resetDay}
            style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, letterSpacing: '.08em', color: S.muted, background: 'none', border: `1px solid ${S.line}`, borderRadius: 99, padding: '8px 16px', cursor: 'pointer' }}
          >
            RESET HARI INI
          </button>
          <Link href="/" style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, textDecoration: 'none' }}>
            ← GANTI USER
          </Link>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 10.5, color: S.muted, opacity: .65, lineHeight: 1.6, maxWidth: 300 }}>
            Centang auto-tersimpan ke cloud. Buka dari device manapun, progress lo tetap sama.
          </div>
        </footer>
      </div>
    </div>
  )
}
