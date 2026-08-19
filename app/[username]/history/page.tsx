'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { supabase } from '@/lib/supabase'
import { toDateStr } from '@/lib/checklist-data'

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488',
} as const

interface QuestHistoryRow {
  quest_date: string
  status: string
  xp: number
  interrupt_id: string | null
}

interface InterruptHistoryRow {
  quest_date: string
  status: string
  summary: string
}

interface LegacyLogRow {
  date: string
  checked_ids: string[]
  item_count: number | null
}

interface DayData {
  date: string
  label: string
  fullLabel: string
  pct: number
  done: number
  total: number
  xp: number
  interruptCount: number
  source: 'quest' | 'legacy' | 'none'
}

function dayLabel(dateStr: string, today: string, yesterday: string, d: Date) {
  if (dateStr === today) return 'Hari ini'
  if (dateStr === yesterday) return 'Kemarin'
  return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' })
}

export default function HistoryPage() {
  const params = useParams()
  const router = useRouter()
  const username = decodeURIComponent(params.username as string)
  const [days, setDays] = useState<DayData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function init() {
      const { data: user } = await supabase.from('users').select('id').eq('name', username).single()
      if (!user) { router.push('/'); return }

      const from30 = toDateStr(new Date(Date.now() - 29 * 864e5))
      const [questResult, interruptResult, legacyResult, itemResult] = await Promise.all([
        supabase
          .from('daily_quests')
          .select('quest_date,status,xp,interrupt_id')
          .eq('user_id', user.id)
          .gte('quest_date', from30)
          .order('quest_date', { ascending: true }),
        supabase
          .from('quest_interrupts')
          .select('quest_date,status,summary')
          .eq('user_id', user.id)
          .gte('quest_date', from30)
          .order('quest_date', { ascending: true }),
        supabase
          .from('daily_logs')
          .select('date,checked_ids,item_count')
          .eq('user_id', user.id)
          .gte('date', from30)
          .order('date', { ascending: true }),
        supabase
          .from('checklist_items')
          .select('id')
          .eq('user_id', user.id)
          .eq('is_deleted', false),
      ])

      if (questResult.error) throw questResult.error
      if (interruptResult.error) throw interruptResult.error
      if (legacyResult.error) throw legacyResult.error
      if (itemResult.error) throw itemResult.error

      const questRows = (questResult.data ?? []) as QuestHistoryRow[]
      const interruptRows = (interruptResult.data ?? []) as InterruptHistoryRow[]
      const legacyRows = (legacyResult.data ?? []) as LegacyLogRow[]
      const fallbackLegacyTotal = (itemResult.data ?? []).length

      const questsByDate = new Map<string, QuestHistoryRow[]>()
      for (const quest of questRows) {
        const list = questsByDate.get(quest.quest_date) ?? []
        list.push(quest)
        questsByDate.set(quest.quest_date, list)
      }

      const interruptsByDate = new Map<string, InterruptHistoryRow[]>()
      for (const interrupt of interruptRows) {
        const list = interruptsByDate.get(interrupt.quest_date) ?? []
        list.push(interrupt)
        interruptsByDate.set(interrupt.quest_date, list)
      }

      const legacyByDate = new Map(legacyRows.map(row => [row.date, row]))
      const today = toDateStr(new Date())
      const yesterday = toDateStr(new Date(Date.now() - 864e5))
      const result: DayData[] = []

      for (let i = 29; i >= 0; i -= 1) {
        const d = new Date(Date.now() - i * 864e5)
        const date = toDateStr(d)
        const dailyQuests = questsByDate.get(date) ?? []
        const dailyInterrupts = interruptsByDate.get(date) ?? []

        if (dailyQuests.length > 0) {
          const actionable = dailyQuests.filter(quest => !['deferred', 'cancelled', 'replaced'].includes(quest.status))
          const doneRows = actionable.filter(quest => quest.status === 'completed')
          const total = actionable.length
          result.push({
            date,
            label: d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
            fullLabel: dayLabel(date, today, yesterday, d),
            pct: total ? Math.round((doneRows.length / total) * 100) : 0,
            done: doneRows.length,
            total,
            xp: doneRows.reduce((sum, quest) => sum + Number(quest.xp || 0), 0),
            interruptCount: dailyInterrupts.length,
            source: 'quest',
          })
          continue
        }

        const legacy = legacyByDate.get(date)
        if (legacy) {
          const done = legacy.checked_ids?.length ?? 0
          const total = legacy.item_count ?? (done > 0 ? fallbackLegacyTotal : 0)
          result.push({
            date,
            label: d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
            fullLabel: dayLabel(date, today, yesterday, d),
            pct: total ? Math.round((done / total) * 100) : 0,
            done,
            total,
            xp: 0,
            interruptCount: dailyInterrupts.length,
            source: 'legacy',
          })
          continue
        }

        result.push({
          date,
          label: d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
          fullLabel: dayLabel(date, today, yesterday, d),
          pct: 0,
          done: 0,
          total: 0,
          xp: 0,
          interruptCount: dailyInterrupts.length,
          source: 'none',
        })
      }

      if (!cancelled) {
        setDays(result)
        setLoading(false)
      }
    }

    void init().catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [username, router])

  const stats = useMemo(() => {
    const questDays = days.filter(day => day.source === 'quest')
    return {
      completed: questDays.reduce((sum, day) => sum + day.done, 0),
      activeDays: days.filter(day => day.total > 0 || day.interruptCount > 0).length,
      interrupts: days.reduce((sum, day) => sum + day.interruptCount, 0),
      average: questDays.length ? Math.round(questDays.reduce((sum, day) => sum + day.pct, 0) / questDays.length) : 0,
    }
  }, [days])

  if (loading) return (
    <div style={{ background: S.bg, minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 10 }}>
      LOADING PROGRESSION…
    </div>
  )

  return (
    <div style={{ background: S.bg, minHeight: '100dvh', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 64 }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '29px 0 18px' }}>
          <Link href={`/${encodeURIComponent(username)}`} style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, color: S.muted, textDecoration: 'none' }}>← TODAY</Link>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, letterSpacing: '.18em', color: S.amber, marginTop: 18 }}>PLAYER PROGRESSION</div>
          <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 'clamp(29px,8vw,39px)', lineHeight: 1, letterSpacing: '-.035em', margin: '8px 0 0' }}>30 days</h1>
          <p style={{ margin: '10px 0 0', color: S.muted, fontSize: 12.5, lineHeight: 1.55, maxWidth: 520 }}>
            What you completed, when the System changed course, and how your days progressed. Older checklist history stays available as a legacy fallback.
          </p>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 9, marginBottom: 20 }}>
          <Stat value={`${stats.completed}`} label="QUEST DONE" />
          <Stat value={`${stats.activeDays}`} label="ACTIVE DAYS" />
          <Stat value={`${stats.interrupts}`} label="INTERRUPTS" />
        </div>

        <section style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 17, padding: '17px 4px 11px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '0 14px 13px' }}>
            <div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 8.5, letterSpacing: '.1em' }}>QUEST COMPLETION</div>
              <div style={{ marginTop: 4, fontFamily: '"Space Grotesk", sans-serif', fontSize: 17, fontWeight: 600 }}>{stats.average}% average on quest days</div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={days} barSize={8}>
              <XAxis dataKey="label" tick={{ fill: S.muted, fontSize: 8.5, fontFamily: '"IBM Plex Mono", monospace' }} axisLine={false} tickLine={false} interval={4} />
              <YAxis domain={[0, 100]} width={32} tick={{ fill: S.muted, fontSize: 8.5, fontFamily: '"IBM Plex Mono", monospace' }} axisLine={false} tickLine={false} tickFormatter={value => `${value}%`} />
              <Tooltip
                contentStyle={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 8, fontFamily: '"IBM Plex Mono", monospace', fontSize: 10 }}
                labelStyle={{ color: S.muted }}
                itemStyle={{ color: S.amber }}
                formatter={(value) => [`${value}%`, 'Completion']}
              />
              <Bar dataKey="pct" radius={[4, 4, 0, 0]}>
                {days.map((day) => <Cell key={day.date} fill={day.interruptCount > 0 ? S.gold : day.pct > 0 ? S.amber : S.line} fillOpacity={day.pct > 0 || day.interruptCount > 0 ? 1 : .45} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 9 }}>
            <h2 style={{ margin: 0, fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, fontSize: 18 }}>Daily progression</h2>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8.5 }}>NEWEST FIRST</div>
          </div>

          <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 17, overflow: 'hidden' }}>
            {[...days].reverse().map((day, index) => (
              <Link
                key={day.date}
                href={`/${encodeURIComponent(username)}/history/${day.date}`}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px', borderTop: index === 0 ? 'none' : `1px solid ${S.line}`, textDecoration: 'none', color: 'inherit' }}
              >
                <div style={{ width: 104, flexShrink: 0, minWidth: 0 }}>
                  <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, fontSize: 12.5, color: day.total > 0 || day.interruptCount > 0 ? S.ink : S.muted }}>{day.fullLabel}</div>
                  <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.muted2, marginTop: 2 }}>
                    {day.source === 'quest' ? `${day.done}/${day.total} QUEST` : day.source === 'legacy' ? `${day.done}/${day.total || '—'} LEGACY` : 'NO ACTIVITY'}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ height: 5, borderRadius: 99, background: '#1c222c', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${day.pct}%`, background: day.interruptCount > 0 ? `linear-gradient(90deg,${S.amber},${S.gold})` : S.amber, opacity: day.pct > 0 ? 1 : 0 }} />
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
                    {day.xp > 0 && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.gold }}>+{day.xp} XP</span>}
                    {day.interruptCount > 0 && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.amber }}>⚠ {day.interruptCount} INTERRUPT{day.interruptCount > 1 ? 'S' : ''}</span>}
                    {day.source === 'legacy' && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.muted2 }}>CHECKLIST HISTORY</span>}
                  </div>
                </div>
                <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 10.5, width: 34, textAlign: 'right', flexShrink: 0, color: day.pct >= 80 ? S.gold : day.pct > 0 ? S.amber : S.muted }}>{day.total > 0 ? `${day.pct}%` : '—'}</div>
                <span aria-hidden="true" style={{ color: S.muted, flexShrink: 0 }}>→</span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 14, padding: '13px 12px' }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 700, fontSize: 'clamp(18px,5vw,23px)', color: S.amber }}>{value}</div>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8, letterSpacing: '.08em', color: S.muted, marginTop: 3 }}>{label}</div>
    </div>
  )
}
