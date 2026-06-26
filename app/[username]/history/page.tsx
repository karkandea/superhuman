'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { supabase } from '@/lib/supabase'
import { TOTAL, ANCHOR_IDS, toDateStr } from '@/lib/checklist-data'

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', gold: '#ffd488',
} as const

interface DayData {
  date: string
  label: string
  pct: number
  anchors: number
}

function computeStreak(days: DayData[]) {
  const qualSet = new Set(days.filter(d => d.anchors === ANCHOR_IDS.length).map(d => d.date))
  let n = 0
  const cur = new Date()
  if (!qualSet.has(toDateStr(cur))) cur.setDate(cur.getDate() - 1)
  while (qualSet.has(toDateStr(cur))) { n++; cur.setDate(cur.getDate() - 1) }
  return n
}

export default function HistoryPage() {
  const params   = useParams()
  const router   = useRouter()
  const username = decodeURIComponent(params.username as string)
  const [days,    setDays]    = useState<DayData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function init() {
      const { data: user } = await supabase
        .from('users').select('id').eq('name', username).single()
      if (!user) { router.push('/'); return }

      const from90 = toDateStr(new Date(Date.now() - 90 * 864e5))
      const { data: logs } = await supabase
        .from('daily_logs').select('date, checked_ids')
        .eq('user_id', user.id).gte('date', from90)
        .order('date', { ascending: true })

      const logMap = new Map((logs ?? []).map(l => [l.date, l.checked_ids as string[]]))

      // build last 30 days for chart
      const result: DayData[] = []
      for (let i = 29; i >= 0; i--) {
        const d   = new Date(Date.now() - i * 864e5)
        const key = toDateStr(d)
        const ids = logMap.get(key) ?? []
        result.push({
          date:    key,
          label:   d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
          pct:     TOTAL ? Math.round((ids.length / TOTAL) * 100) : 0,
          anchors: ANCHOR_IDS.filter(a => ids.includes(a)).length,
        })
      }

      setDays(result)
      setLoading(false)
    }
    init()
  }, [username, router])

  const avg    = days.length ? Math.round(days.reduce((s, d) => s + d.pct, 0) / days.length) : 0
  const best   = days.reduce((b, d) => d.pct > b ? d.pct : b, 0)
  const streak = computeStreak(days)

  if (loading) return (
    <div style={{ background: S.bg, minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace' }}>
      loading...
    </div>
  )

  return (
    <div style={{ background: S.bg, minHeight: '100dvh', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 64 }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '0 18px' }}>

        <header style={{ padding: '34px 0 18px' }}>
          <Link href={`/${encodeURIComponent(username)}`} style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, textDecoration: 'none' }}>
            ← KEMBALI
          </Link>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, letterSpacing: '.18em', textTransform: 'uppercase', color: S.muted, marginTop: 16 }}>
            HISTORY · {username.toUpperCase()}
          </div>
          <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 28, margin: '10px 0 24px' }}>
            30 Hari Terakhir
          </h1>
        </header>

        {/* stat cards */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
          {[
            { num: `${avg}%`,    lbl: 'Rata-rata'   },
            { num: `${best}%`,   lbl: 'Best day'    },
            { num: `${streak}`,  lbl: 'Streak skrg' },
          ].map(s => (
            <div key={s.lbl} style={{ flex: 1, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: '14px 16px' }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 600, fontSize: 22, color: S.amber }}>{s.num}</div>
              <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: S.muted, marginTop: 2 }}>{s.lbl}</div>
            </div>
          ))}
        </div>

        {/* bar chart */}
        <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, padding: '20px 4px 12px' }}>
          <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, fontSize: 14, color: S.muted, padding: '0 16px 16px' }}>
            % Completion per hari
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={days} barSize={8}>
              <XAxis
                dataKey="label"
                tick={{ fill: S.muted, fontSize: 9, fontFamily: '"IBM Plex Mono", monospace' }}
                axisLine={false} tickLine={false} interval={4}
              />
              <YAxis
                domain={[0, 100]} width={34}
                tick={{ fill: S.muted, fontSize: 9, fontFamily: '"IBM Plex Mono", monospace' }}
                axisLine={false} tickLine={false}
                tickFormatter={v => `${v}%`}
              />
              <Tooltip
                contentStyle={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 8, fontFamily: '"IBM Plex Mono", monospace', fontSize: 11 }}
                labelStyle={{ color: S.muted }}
                itemStyle={{ color: S.amber }}
                formatter={(v: number) => [`${v}%`, 'Completion']}
              />
              <Bar dataKey="pct" radius={[4, 4, 0, 0]}>
                {days.map((d, i) => (
                  <Cell
                    key={i}
                    fill={d.anchors === ANCHOR_IDS.length ? S.gold : d.pct > 0 ? S.amber : S.line}
                    fillOpacity={d.pct > 0 ? 1 : 0.5}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', padding: '10px 16px 0', fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, color: S.muted }}>
            <span><span style={{ color: S.gold }}>■</span> 5 jangkar ✓</span>
            <span><span style={{ color: S.amber }}>■</span> partial</span>
            <span><span style={{ color: S.line }}>■</span> kosong</span>
          </div>
        </div>

        {/* list breakdown */}
        <section style={{ marginTop: 26 }}>
          <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, fontSize: 16, marginBottom: 12 }}>Breakdown Harian</div>
          <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, overflow: 'hidden' }}>
            {[...days].reverse().map((d, idx) => (
              <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: idx === 0 ? 'none' : `1px solid ${S.line}` }}>
                <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, width: 60, flexShrink: 0 }}>
                  {d.label}
                </div>
                <div style={{ flex: 1, height: 4, borderRadius: 99, background: '#1c222c', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${d.pct}%`, transition: 'width 400ms ease',
                    background: d.anchors === ANCHOR_IDS.length
                      ? `linear-gradient(90deg,${S.amber},${S.gold})`
                      : S.amber,
                    opacity: d.pct > 0 ? 1 : 0,
                  }} />
                </div>
                <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, width: 36, textAlign: 'right', flexShrink: 0, color: d.pct >= 80 ? S.gold : d.pct > 0 ? S.amber : S.muted }}>
                  {d.pct > 0 ? `${d.pct}%` : '—'}
                </div>
                <span style={{ fontSize: 12, width: 16, flexShrink: 0 }}>
                  {d.anchors === ANCHOR_IDS.length ? '⚡' : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}