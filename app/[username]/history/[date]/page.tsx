'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { DATA, TOTAL, ANCHOR_IDS, toDateStr } from '@/lib/checklist-data'

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', gold: '#ffd488',
} as const

export default function DayDetailPage() {
  const params   = useParams()
  const router   = useRouter()
  const username = decodeURIComponent(params.username as string)
  const date     = params.date as string

  const [checked, setChecked] = useState<string[]>([])
  const [found,   setFound]   = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function init() {
      const { data: user } = await supabase
        .from('users').select('id').eq('name', username).single()
      if (!user) { router.push('/'); return }

      const { data: log } = await supabase
        .from('daily_logs').select('checked_ids')
        .eq('user_id', user.id).eq('date', date).single()

      setChecked(log?.checked_ids ?? [])
      setFound(!!log)
      setLoading(false)
    }
    init()
  }, [username, date, router])

  const pct         = TOTAL ? Math.round((checked.length / TOTAL) * 100) : 0
  const p           = TOTAL ? checked.length / TOTAL : 0
  const anchorsDone = ANCHOR_IDS.filter(a => checked.includes(a)).length
  const allAnchors  = anchorsDone === ANCHOR_IDS.length

  const today     = toDateStr(new Date())
  const yesterday = toDateStr(new Date(Date.now() - 864e5))
  const [y, m, dd] = date.split('-').map(Number)
  const dObj = new Date(y, m - 1, dd)
  const niceDate = dObj.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const headline = date === today ? 'Hari ini' : date === yesterday ? 'Kemarin' : niceDate

  if (loading) return (
    <div style={{ background: S.bg, minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace' }}>
      loading...
    </div>
  )

  return (
    <div style={{ background: S.bg, minHeight: '100dvh', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 64 }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '0 18px' }}>

        <header style={{ padding: '34px 0 18px' }}>
          <Link href={`/${encodeURIComponent(username)}/history`} style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, textDecoration: 'none' }}>
            ← KEMBALI KE HISTORY
          </Link>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, letterSpacing: '.18em', textTransform: 'uppercase', color: S.muted, marginTop: 16 }}>
            {niceDate}
          </div>
          <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 28, margin: '10px 0 22px' }}>
            {headline}
          </h1>

          {!found ? (
            <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: '20px', textAlign: 'center', fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, color: S.muted }}>
              Ga ada data buat hari ini — belum ada yang dicentang.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
                <div style={{ flex: 1, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: '14px 16px' }}>
                  <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 600, fontSize: 26, color: pct > 50 ? S.gold : S.ink }}>{pct}%</div>
                  <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: S.muted }}>Progress</div>
                </div>
                <div style={{ flex: 1, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: '14px 16px' }}>
                  <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 600, fontSize: 26, color: S.amber }}>{checked.length}/{TOTAL}</div>
                  <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: S.muted }}>Item selesai</div>
                </div>
              </div>

              <div style={{ height: 6, borderRadius: 99, background: '#1c222c', overflow: 'hidden', margin: '16px 0 10px' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: `linear-gradient(90deg,${S.amber},${S.gold})`, transition: 'width 450ms ease' }} />
              </div>

              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, textAlign: 'center' }}>
                {allAnchors
                  ? <span>⚡ <strong style={{ color: S.amber }}>5 jangkar kelar hari itu.</strong></span>
                  : <span>Jangkar wajib: <strong style={{ color: S.amber }}>{anchorsDone}/{ANCHOR_IDS.length}</strong> kelar</span>
                }
              </div>
            </>
          )}
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
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 13,
                        padding: '15px 16px',
                        borderTop: idx === 0 ? 'none' : `1px solid ${S.line}`,
                        background: done ? 'rgba(246,178,75,0.03)' : 'transparent',
                      }}
                    >
                      <span style={{
                        flexShrink: 0, width: 22, height: 22, borderRadius: 7, marginTop: 1,
                        display: 'grid', placeItems: 'center',
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
                      <span style={{ fontSize: 14.5, lineHeight: 1.4, letterSpacing: '.005em', color: done ? S.ink : S.muted }}>
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
      </div>
    </div>
  )
}
