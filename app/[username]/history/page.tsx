'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { supabase } from '@/lib/supabase'
import { toDateStr } from '@/lib/checklist-data'
import {
  deriveUnderstandingStage,
  extractCurrentPicture,
  extractUnderstandingChanges,
  type UnderstandingStage,
} from '@/lib/system-understanding-ui'

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
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

interface BriefRow {
  version: number
  brief: Record<string, unknown>
  created_at: string
}

interface StrategicRow {
  map: Record<string, unknown>
  generated_at: string
}

interface ResponseModelRow {
  model: Record<string, unknown>
  generated_at: string
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

function formatMoment(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })
}

export default function ProgressionPage() {
  const params = useParams()
  const router = useRouter()
  const username = decodeURIComponent(params.username as string)
  const [days, setDays] = useState<DayData[]>([])
  const [currentBrief, setCurrentBrief] = useState<Record<string, unknown> | null>(null)
  const [previousBrief, setPreviousBrief] = useState<Record<string, unknown> | null>(null)
  const [progressionMap, setProgressionMap] = useState<Record<string, unknown> | null>(null)
  const [responseModel, setResponseModel] = useState<Record<string, unknown> | null>(null)
  const [understandingUpdatedAt, setUnderstandingUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [showAllExecution, setShowAllExecution] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function init() {
      const { data: user } = await supabase.from('users').select('id').eq('name', username).single()
      if (!user) {
        router.push('/')
        return
      }

      const from30 = toDateStr(new Date(Date.now() - 29 * 864e5))
      const [briefResult, mapResult, responseResult, questResult, interruptResult, legacyResult, itemResult] = await Promise.all([
        supabase
          .from('player_briefs')
          .select('version,brief,created_at')
          .eq('user_id', user.id)
          .order('version', { ascending: false })
          .limit(2),
        supabase
          .from('progression_maps')
          .select('map,generated_at')
          .eq('user_id', user.id)
          .eq('is_current', true)
          .maybeSingle(),
        supabase
          .from('player_response_models')
          .select('model,generated_at')
          .eq('user_id', user.id)
          .eq('is_current', true)
          .maybeSingle(),
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

      for (const result of [briefResult, mapResult, responseResult, questResult, interruptResult, legacyResult, itemResult]) {
        if (result.error) throw result.error
      }

      const briefRows = (briefResult.data ?? []) as BriefRow[]
      const strategic = mapResult.data as StrategicRow | null
      const response = responseResult.data as ResponseModelRow | null
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
        setCurrentBrief(briefRows[0]?.brief ?? null)
        setPreviousBrief(briefRows[1]?.brief ?? null)
        setProgressionMap(strategic?.map ?? null)
        setResponseModel(response?.model ?? null)
        setUnderstandingUpdatedAt(response?.generated_at ?? strategic?.generated_at ?? briefRows[0]?.created_at ?? null)
        setDays(result)
        setLoading(false)
      }
    }

    void init().catch(() => {
      if (!cancelled) {
        setLoadError(true)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [username, router])

  const stage = useMemo(() => deriveUnderstandingStage({
    playerBrief: currentBrief,
    progressionMap,
    responseModel,
  }), [currentBrief, progressionMap, responseModel])

  const currentPicture = useMemo(() => extractCurrentPicture({
    playerBrief: currentBrief,
    progressionMap,
    responseModel,
  }), [currentBrief, progressionMap, responseModel])

  const changes = useMemo(
    () => extractUnderstandingChanges(currentBrief, previousBrief ?? undefined),
    [currentBrief, previousBrief],
  )

  const stats = useMemo(() => {
    const questDays = days.filter(day => day.source === 'quest')
    return {
      completed: questDays.reduce((sum, day) => sum + day.done, 0),
      activeDays: days.filter(day => day.total > 0 || day.interruptCount > 0).length,
      interrupts: days.reduce((sum, day) => sum + day.interruptCount, 0),
      average: questDays.length ? Math.round(questDays.reduce((sum, day) => sum + day.pct, 0) / questDays.length) : 0,
    }
  }, [days])

  const visibleDays = useMemo(() => {
    const reversed = [...days].reverse()
    return showAllExecution ? reversed : reversed.slice(0, 7)
  }, [days, showAllExecution])

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif' }}>
        <div style={{ maxWidth: 620, margin: '0 auto', padding: '29px 18px 96px' }}>
          <div style={{ width: 74, height: 9, background: S.line, borderRadius: 99 }} />
          <div style={{ width: 210, height: 38, background: S.panel, borderRadius: 10, marginTop: 22 }} />
          <div style={{ height: 132, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, marginTop: 22 }} />
          <div style={{ height: 210, background: S.panel2, borderRadius: 16, marginTop: 18 }} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: S.bg, minHeight: '100dvh', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 78 }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '29px 0 18px' }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, letterSpacing: '.16em', color: S.amber }}>PLAYER PROGRESSION</div>
          <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 'clamp(34px,9vw,46px)', lineHeight: .98, letterSpacing: '-.045em', margin: '8px 0 0' }}>Progression</h1>
          <p style={{ margin: '10px 0 0', color: S.muted, fontSize: 12.5, lineHeight: 1.55, maxWidth: 520 }}>
            Yang System pahami tentang lo, apa yang sedang bergerak, dan pola yang mulai kebaca.
          </p>
        </header>

        {loadError ? (
          <section style={{ marginTop: 8, borderTop: `1px solid ${S.line}`, borderBottom: `1px solid ${S.line}`, padding: '18px 0' }}>
            <div style={{ color: S.ink, fontSize: 13 }}>Progression belum bisa dibaca sekarang.</div>
            <div style={{ marginTop: 4, color: S.muted, fontSize: 11.5 }}>Data lo tetap aman. Coba buka lagi sebentar lagi.</div>
          </section>
        ) : (
          <>
            <section style={{ marginTop: 6, border: `1px solid ${S.line}`, borderRadius: 18, background: S.panel, padding: '16px 15px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <UnderstandingSignal stage={stage} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, letterSpacing: '.12em' }}>{stage.label}</div>
                  <div style={{ marginTop: 5, fontFamily: '"Space Grotesk", sans-serif', fontSize: 21, fontWeight: 680, letterSpacing: '-.02em' }}>{stage.title}</div>
                  <div style={{ marginTop: 5, color: S.muted, fontSize: 11.8, lineHeight: 1.5 }}>{stage.description}</div>
                </div>
              </div>
              <div style={{ marginTop: 13, paddingTop: 10, borderTop: `1px solid ${S.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8 }}>
                  {understandingUpdatedAt ? `TERAKHIR BERUBAH · ${formatMoment(understandingUpdatedAt)}` : 'TERUS BERKEMBANG DARI UPDATE LO'}
                </span>
                <Link href={`/${encodeURIComponent(username)}/vault`} style={{ color: S.gold, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.2, fontWeight: 700 }}>
                  BUKA VAULT →
                </Link>
              </div>
            </section>

            <section style={{ marginTop: 28 }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.13em' }}>CURRENT PICTURE</div>
              <h2 style={{ margin: '7px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 22, fontWeight: 650, letterSpacing: '-.025em' }}>Yang kebaca sekarang</h2>

              {currentPicture.length === 0 ? (
                <div style={{ marginTop: 12, padding: '17px 0', borderTop: `1px solid ${S.line}`, borderBottom: `1px solid ${S.line}`, color: S.muted, fontSize: 12.5, lineHeight: 1.55 }}>
                  System masih membentuk gambaran awal. Update penting yang lo ceritain di Vault akan membantu mempertajamnya.
                </div>
              ) : (
                <div style={{ marginTop: 11, borderTop: `1px solid ${S.line}` }}>
                  {currentPicture.map(item => (
                    <div key={item.id} style={{ padding: '14px 1px 15px', borderBottom: `1px solid ${S.line}` }}>
                      <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8, letterSpacing: '.08em' }}>{item.label.toUpperCase()}</div>
                      <div style={{ marginTop: 5, color: '#d8d7d2', fontSize: 13, lineHeight: 1.52 }}>{item.summary}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section style={{ marginTop: 29 }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.13em' }}>WHAT CHANGED</div>
              <h2 style={{ margin: '7px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 22, fontWeight: 650, letterSpacing: '-.025em' }}>Pemahaman yang bergerak</h2>

              {changes.length > 0 ? (
                <div style={{ marginTop: 11, borderTop: `1px solid ${S.line}` }}>
                  {changes.map(change => (
                    <div key={change.id} style={{ padding: '13px 1px 14px', borderBottom: `1px solid ${S.line}` }}>
                      <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontSize: 8, letterSpacing: '.08em' }}>{change.label.toUpperCase()}</div>
                      <div style={{ marginTop: 5, color: '#d8d7d2', fontSize: 12.5, lineHeight: 1.5 }}>{change.summary}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 12, padding: '15px 0', borderTop: `1px solid ${S.line}`, borderBottom: `1px solid ${S.line}`, color: S.muted, fontSize: 12, lineHeight: 1.5 }}>
                  {previousBrief
                    ? 'Belum ada perubahan utama yang perlu ditonjolkan. System tetap memakai konteks yang sudah ada.'
                    : 'Ini masih titik awal. Perubahan penting akan muncul di sini saat pemahaman System benar-benar bergeser.'}
                </div>
              )}
            </section>

            <section style={{ marginTop: 34 }}>
              <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8.5, letterSpacing: '.13em' }}>EXECUTION</div>
                  <h2 style={{ margin: '7px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 21, fontWeight: 650, letterSpacing: '-.02em' }}>30 hari terakhir</h2>
                </div>
                <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8 }}>BUKTI EKSEKUSI</div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 8, marginTop: 13 }}>
                <Stat value={`${stats.completed}`} label="QUEST DONE" />
                <Stat value={`${stats.activeDays}`} label="ACTIVE DAYS" />
                <Stat value={`${stats.interrupts}`} label="INTERRUPTS" />
              </div>

              <div style={{ marginTop: 10, border: `1px solid ${S.line}`, borderRadius: 16, background: S.panel2, padding: '14px 2px 8px' }}>
                <div style={{ padding: '0 12px 8px', display: 'flex', justifyContent: 'space-between', gap: 12, color: S.muted, fontSize: 10.5 }}>
                  <span>Quest completion</span>
                  <span style={{ color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>{stats.average}% AVG</span>
                </div>
                <ResponsiveContainer width="100%" height={132}>
                  <BarChart data={days} barSize={7}>
                    <XAxis dataKey="label" tick={{ fill: S.muted2, fontSize: 7.5, fontFamily: '"IBM Plex Mono", monospace' }} axisLine={false} tickLine={false} interval={5} />
                    <YAxis domain={[0, 100]} width={28} tick={{ fill: S.muted2, fontSize: 7.5, fontFamily: '"IBM Plex Mono", monospace' }} axisLine={false} tickLine={false} tickFormatter={value => `${value}%`} />
                    <Tooltip
                      contentStyle={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 8, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}
                      labelStyle={{ color: S.muted }}
                      itemStyle={{ color: S.amber }}
                      formatter={(value) => [`${value}%`, 'Completion']}
                    />
                    <Bar dataKey="pct" radius={[3, 3, 0, 0]}>
                      {days.map(day => <Cell key={day.date} fill={day.interruptCount > 0 ? S.gold : day.pct > 0 ? S.amber : S.line} fillOpacity={day.pct > 0 || day.interruptCount > 0 ? 1 : .42} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div style={{ marginTop: 13, borderTop: `1px solid ${S.line}` }}>
                {visibleDays.map(day => (
                  <Link
                    key={day.date}
                    href={`/${encodeURIComponent(username)}/history/${day.date}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 1px', borderBottom: `1px solid ${S.line}`, textDecoration: 'none', color: 'inherit' }}
                  >
                    <div style={{ width: 102, flexShrink: 0, minWidth: 0 }}>
                      <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, fontSize: 12.5, color: day.total > 0 || day.interruptCount > 0 ? S.ink : S.muted }}>{day.fullLabel}</div>
                      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.muted2, marginTop: 2 }}>
                        {day.source === 'quest' ? `${day.done}/${day.total} QUEST` : day.source === 'legacy' ? `${day.done}/${day.total || '—'} LEGACY` : 'NO ACTIVITY'}
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ height: 4, borderRadius: 99, background: '#1c222c', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${day.pct}%`, background: day.interruptCount > 0 ? `linear-gradient(90deg,${S.amber},${S.gold})` : S.amber, opacity: day.pct > 0 ? 1 : 0 }} />
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
                        {day.xp > 0 && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8, color: S.gold }}>+{day.xp} XP</span>}
                        {day.interruptCount > 0 && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8, color: S.amber }}>⚠ {day.interruptCount} INTERRUPT{day.interruptCount > 1 ? 'S' : ''}</span>}
                      </div>
                    </div>
                    <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: day.pct > 0 ? S.amber : S.muted2, flexShrink: 0 }}>{day.total > 0 ? `${day.pct}%` : '—'}</span>
                    <span aria-hidden="true" style={{ color: S.muted2, flexShrink: 0 }}>→</span>
                  </Link>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setShowAllExecution(value => !value)}
                style={{ marginTop: 12, border: 0, background: 'transparent', padding: '4px 0', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: 'pointer' }}
              >
                {showAllExecution ? 'TAMPILKAN LEBIH SEDIKIT ↑' : 'LIHAT SEMUA 30 HARI →'}
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function UnderstandingSignal({ stage }: { stage: UnderstandingStage }) {
  return (
    <div aria-hidden="true" style={{ width: 82, height: 82, flexShrink: 0, position: 'relative', display: 'grid', placeItems: 'center' }}>
      {[0, 1, 2].map(index => {
        const active = index < stage.depth
        const inset = index * 10
        return (
          <span key={index} style={{ position: 'absolute', inset, borderRadius: 999, border: `1px solid ${active ? S.amber : S.lineStrong}`, opacity: active ? .34 + index * .18 : .35, boxShadow: index === stage.depth - 1 && active ? '0 0 20px rgba(246,178,75,.08)' : 'none' }} />
        )
      })}
      <span style={{ width: 8, height: 8, borderRadius: 99, background: S.gold, boxShadow: '0 0 18px rgba(255,212,136,.45)' }} />
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ border: `1px solid ${S.line}`, borderRadius: 13, padding: '11px 10px', background: S.panel2 }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 700, fontSize: 'clamp(17px,5vw,21px)', color: S.amber }}>{value}</div>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.2, letterSpacing: '.07em', color: S.muted2, marginTop: 3 }}>{label}</div>
    </div>
  )
}
