'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { CATEGORY_LABEL, CATEGORY_ORDER, type Category, toDateStr } from '@/lib/checklist-data'
import { questKindLabel } from '@/lib/quest-system'

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

interface QuestRow {
  id: string
  title: string
  category: Category
  kind: 'main' | 'side' | 'maintenance' | 'bonus'
  difficulty: 'easy' | 'medium' | 'hard'
  priority: number
  xp: number
  rationale: string | null
  source: string
  status: string
  created_at: string
  completed_at: string | null
  revision: number
  interrupt_id: string | null
  interrupt_reason: string | null
}

interface InterruptRow {
  id: string
  status: string
  summary: string
  created_at: string
  applied_at: string | null
}

interface InterruptActionRow {
  id: string
  interrupt_id: string
  ordinal: number
  action: 'add' | 'replace' | 'defer' | 'cancel' | 'reprioritize'
  target_quest_id: string | null
  result_quest_id: string | null
  new_priority: number | null
  reason: string
  before_state: Record<string, unknown>
  after_state: Record<string, unknown>
}

interface LegacyItem {
  id: string
  label: string
  category: Category
  anchor: boolean
  is_deleted: boolean
  sort_order: number
}

function statusLabel(status: string) {
  if (status === 'completed') return 'COMPLETED'
  if (status === 'pending') return 'ACTIVE'
  if (status === 'partial') return 'PARTIAL'
  if (status === 'deferred') return 'DEFERRED'
  if (status === 'replaced') return 'REPLACED'
  if (status === 'cancelled') return 'CANCELLED'
  if (status === 'skipped') return 'SKIPPED'
  if (status === 'failed') return 'FAILED'
  return status.toUpperCase()
}

function statusColor(status: string) {
  if (status === 'completed') return S.amber
  if (['deferred', 'replaced', 'cancelled', 'skipped'].includes(status)) return S.muted
  if (status === 'failed') return S.red
  return S.gold
}

function actionTitle(action: InterruptActionRow, questTitleById: Map<string, string>) {
  const target = action.target_quest_id ? questTitleById.get(action.target_quest_id) : null
  const result = action.result_quest_id ? questTitleById.get(action.result_quest_id) : null
  if (action.action === 'add') return `Added · ${result ?? String(action.after_state?.title ?? 'New quest')}`
  if (action.action === 'replace') return `Replaced · ${target ?? String(action.before_state?.title ?? 'Quest')}${result ? ` → ${result}` : ''}`
  if (action.action === 'defer') return `Deferred · ${target ?? String(action.before_state?.title ?? 'Quest')}`
  if (action.action === 'cancel') return `Cancelled · ${target ?? String(action.before_state?.title ?? 'Quest')}`
  return `Priority changed · ${target ?? String(action.before_state?.title ?? 'Quest')}${action.new_priority ? ` → P${action.new_priority}` : ''}`
}

export default function DayDetailPage() {
  const params = useParams()
  const router = useRouter()
  const username = decodeURIComponent(params.username as string)
  const date = params.date as string

  const [quests, setQuests] = useState<QuestRow[]>([])
  const [interrupts, setInterrupts] = useState<InterruptRow[]>([])
  const [interruptActions, setInterruptActions] = useState<InterruptActionRow[]>([])
  const [legacyChecked, setLegacyChecked] = useState<string[]>([])
  const [legacyItems, setLegacyItems] = useState<LegacyItem[]>([])
  const [legacyFound, setLegacyFound] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function init() {
      const { data: user } = await supabase.from('users').select('id').eq('name', username).single()
      if (!user) { router.push('/'); return }

      const [questResult, interruptResult, legacyResult, itemResult] = await Promise.all([
        supabase
          .from('daily_quests')
          .select('id,title,category,kind,difficulty,priority,xp,rationale,source,status,created_at,completed_at,revision,interrupt_id,interrupt_reason')
          .eq('user_id', user.id)
          .eq('quest_date', date)
          .order('priority', { ascending: false })
          .order('created_at', { ascending: true }),
        supabase
          .from('quest_interrupts')
          .select('id,status,summary,created_at,applied_at')
          .eq('user_id', user.id)
          .eq('quest_date', date)
          .order('created_at', { ascending: true }),
        supabase
          .from('daily_logs')
          .select('checked_ids')
          .eq('user_id', user.id)
          .eq('date', date)
          .maybeSingle(),
        supabase
          .from('checklist_items')
          .select('id,label,category,anchor,is_deleted,sort_order')
          .eq('user_id', user.id)
          .lte('created_at', `${date}T23:59:59`)
          .order('sort_order', { ascending: true }),
      ])

      if (questResult.error) throw questResult.error
      if (interruptResult.error) throw interruptResult.error
      if (legacyResult.error) throw legacyResult.error
      if (itemResult.error) throw itemResult.error

      const interruptRows = (interruptResult.data ?? []) as InterruptRow[]
      let actions: InterruptActionRow[] = []
      if (interruptRows.length > 0) {
        const { data, error } = await supabase
          .from('quest_interrupt_actions')
          .select('id,interrupt_id,ordinal,action,target_quest_id,result_quest_id,new_priority,reason,before_state,after_state')
          .eq('user_id', user.id)
          .in('interrupt_id', interruptRows.map(interrupt => interrupt.id))
          .order('ordinal', { ascending: true })
        if (error) throw error
        actions = (data ?? []) as InterruptActionRow[]
      }

      if (cancelled) return
      setQuests((questResult.data ?? []) as QuestRow[])
      setInterrupts(interruptRows)
      setInterruptActions(actions)
      setLegacyChecked(legacyResult.data?.checked_ids ?? [])
      setLegacyFound(Boolean(legacyResult.data))
      setLegacyItems((itemResult.data ?? []) as LegacyItem[])
      setLoadFailed(false)
      setLoading(false)
    }

    void init().catch(() => {
      if (!cancelled) {
        setLoadFailed(true)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [username, date, router])

  const today = toDateStr(new Date())
  const yesterdayDate = new Date()
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = toDateStr(yesterdayDate)
  const [year, month, day] = date.split('-').map(Number)
  const dateObject = new Date(year, month - 1, day)
  const niceDate = dateObject.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const headline = date === today ? 'Hari ini' : date === yesterday ? 'Kemarin' : niceDate

  const actionableQuests = quests.filter(quest => !['deferred', 'cancelled', 'replaced'].includes(quest.status))
  const completedQuests = actionableQuests.filter(quest => quest.status === 'completed')
  const changedQuests = quests.filter(quest => ['deferred', 'cancelled', 'replaced'].includes(quest.status))
  const questPct = actionableQuests.length ? Math.round((completedQuests.length / actionableQuests.length) * 100) : 0
  const xpEarned = completedQuests.reduce((sum, quest) => sum + Number(quest.xp || 0), 0)
  const questTitleById = useMemo(() => new Map(quests.map(quest => [quest.id, quest.title])), [quests])
  const legacyPct = legacyItems.length ? Math.round((legacyChecked.length / legacyItems.length) * 100) : 0

  if (loading) return (
    <div style={{ background: S.bg, minHeight: '100dvh', display: 'grid', placeItems: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 10 }}>
      LOADING DAILY PROGRESSION…
    </div>
  )

  return (
    <div style={{ background: S.bg, minHeight: '100dvh', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 64 }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '29px 0 18px' }}>
          <Link href={`/${encodeURIComponent(username)}/history`} style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, color: S.muted, textDecoration: 'none' }}>← PROGRESSION</Link>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, letterSpacing: '.16em', color: S.muted, marginTop: 17 }}>{niceDate.toUpperCase()}</div>
          <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 'clamp(29px,8vw,39px)', lineHeight: 1, letterSpacing: '-.035em', margin: '8px 0 0' }}>{headline}</h1>
        </header>

        {loadFailed && (
          <div role="status" style={{ border: `1px solid ${S.line}`, borderRadius: 14, background: S.panel2, padding: '14px', color: S.muted, fontSize: 12, lineHeight: 1.5 }}>
            Progression for this day could not load. No data was changed.
          </div>
        )}

        {!loadFailed && quests.length > 0 && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 9 }}>
              <Stat value={`${questPct}%`} label="PROGRESS" />
              <Stat value={`${completedQuests.length}/${actionableQuests.length}`} label="QUEST DONE" />
              <Stat value={`+${xpEarned}`} label="XP" />
            </div>

            {interrupts.length > 0 && (
              <section style={{ marginTop: 20 }}>
                <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.13em', marginBottom: 8 }}>SYSTEM INTERRUPT</div>
                <div style={{ display: 'grid', gap: 9 }}>
                  {interrupts.map(interrupt => {
                    const actions = interruptActions.filter(action => action.interrupt_id === interrupt.id)
                    return (
                      <article key={interrupt.id} style={{ border: '1px solid #4d4126', background: 'linear-gradient(135deg,#17150f,#11151c)', borderRadius: 15, padding: '14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <span style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontSize: 8.5, letterSpacing: '.09em' }}>{interrupt.status === 'applied' ? 'APPLIED' : interrupt.status.toUpperCase()}</span>
                          <time style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8.5 }}>{new Date(interrupt.applied_at ?? interrupt.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time>
                        </div>
                        <div style={{ marginTop: 6, color: S.ink, fontSize: 13.5, fontWeight: 600, lineHeight: 1.45 }}>{interrupt.summary}</div>
                        {actions.length > 0 && (
                          <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                            {actions.map(action => (
                              <div key={action.id} style={{ borderTop: `1px solid ${S.line}`, paddingTop: 7 }}>
                                <div style={{ color: S.gold, fontSize: 11.5, lineHeight: 1.4 }}>{actionTitle(action, questTitleById)}</div>
                                <div style={{ marginTop: 3, color: S.muted, fontSize: 10.5, lineHeight: 1.45 }}>{action.reason}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </article>
                    )
                  })}
                </div>
              </section>
            )}

            <section style={{ marginTop: 23 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.13em' }}>DAILY QUEST</div>
                <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8.5 }}>{quests.length} TOTAL RECORDS</div>
              </div>

              {CATEGORY_ORDER.map(category => {
                const rows = quests.filter(quest => quest.category === category)
                if (!rows.length) return null
                return (
                  <div key={category} style={{ marginTop: 15 }}>
                    <div style={{ margin: '0 2px 6px', fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 8.5, letterSpacing: '.1em' }}>{CATEGORY_LABEL[category].toUpperCase()}</div>
                    <div style={{ display: 'grid', gap: 7 }}>
                      {rows.map(quest => (
                        <article key={quest.id} style={{ border: `1px solid ${quest.interrupt_id ? '#443a24' : S.line}`, background: quest.interrupt_id ? 'linear-gradient(135deg,#17150f,#13171f)' : S.panel, borderRadius: 14, padding: '12px 13px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: quest.kind === 'main' ? S.amber : S.muted }}>{questKindLabel[quest.kind]}</span>
                                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.gold }}>+{quest.xp} XP</span>
                                {quest.interrupt_id && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.gold }}>INTERRUPT</span>}
                              </div>
                              <div style={{ marginTop: 5, color: ['replaced', 'cancelled'].includes(quest.status) ? S.muted : S.ink, fontSize: 13.5, lineHeight: 1.42, textDecoration: ['replaced', 'cancelled'].includes(quest.status) ? 'line-through' : 'none' }}>{quest.title}</div>
                            </div>
                            <span style={{ flexShrink: 0, fontFamily: '"IBM Plex Mono", monospace', color: statusColor(quest.status), fontSize: 8.2, letterSpacing: '.06em' }}>{statusLabel(quest.status)}</span>
                          </div>
                          {quest.rationale && <div style={{ marginTop: 6, color: S.muted, fontSize: 10.5, lineHeight: 1.45 }}>{quest.rationale}</div>}
                          {quest.interrupt_reason && <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${S.line}`, color: S.muted2, fontSize: 10.5, lineHeight: 1.45 }}>{quest.interrupt_reason}</div>}
                        </article>
                      ))}
                    </div>
                  </div>
                )
              })}
            </section>

            {changedQuests.length > 0 && (
              <div style={{ marginTop: 14, color: S.muted2, fontSize: 10.5, lineHeight: 1.5 }}>
                Deferred, replaced, and cancelled quests stay in history so the day remains understandable without exposing database logs.
              </div>
            )}
          </>
        )}

        {!loadFailed && quests.length === 0 && (
          <section style={{ border: `1px solid ${S.line}`, background: S.panel, borderRadius: 16, padding: '16px' }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: legacyFound ? S.gold : S.muted, fontSize: 8.5, letterSpacing: '.12em' }}>{legacyFound ? 'LEGACY CHECKLIST HISTORY' : 'NO PROGRESSION DATA'}</div>
            <div style={{ marginTop: 7, color: S.ink, fontFamily: '"Space Grotesk", sans-serif', fontSize: 18, fontWeight: 600 }}>{legacyFound ? `${legacyPct}% complete` : 'Nothing recorded for this day.'}</div>
            <div style={{ marginTop: 6, color: S.muted, fontSize: 11.5, lineHeight: 1.5 }}>{legacyFound ? 'This date predates the current AI Daily Quest flow, so the original checklist record is preserved below.' : 'No Daily Quest or legacy checklist activity was found.'}</div>
          </section>
        )}

        {!loadFailed && legacyFound && (
          <section style={{ marginTop: quests.length > 0 ? 28 : 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 8.5, letterSpacing: '.12em' }}>LEGACY CHECKLIST</div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8.5 }}>{legacyChecked.length}/{legacyItems.length} COMPLETE</div>
            </div>
            <div style={{ border: `1px solid ${S.line}`, background: S.panel2, borderRadius: 15, overflow: 'hidden' }}>
              {legacyItems.map((item, index) => {
                const done = legacyChecked.includes(item.id)
                return (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderTop: index ? `1px solid ${S.line}` : 'none' }}>
                    <span aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 6, display: 'grid', placeItems: 'center', background: done ? S.amber : 'transparent', border: done ? 'none' : `1px solid ${S.lineStrong}`, color: S.bg, fontSize: 11, fontWeight: 800 }}>{done ? '✓' : ''}</span>
                    <span style={{ color: done ? S.ink : S.muted, fontSize: 12.5, lineHeight: 1.4 }}>{item.label}</span>
                    {item.anchor && <span style={{ marginLeft: 'auto', fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 7.8 }}>ANCHOR</span>}
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 14, padding: '13px 12px' }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontWeight: 700, fontSize: 'clamp(18px,5vw,23px)' }}>{value}</div>
      <div style={{ marginTop: 3, fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 7.8, letterSpacing: '.08em' }}>{label}</div>
    </div>
  )
}
