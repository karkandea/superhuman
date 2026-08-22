'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { todayStr } from '@/lib/checklist-data'
import { SystemEyebrow, SystemLine, SystemMoment, SystemPulse } from './system-moment'

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35', ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', gold: '#ffd488',
} as const

interface QuestRow {
  id: string
  title: string
  kind: 'main' | 'side' | 'maintenance' | 'bonus'
  status: string
}

const POLL_MS = 2500
const MAX_POLLS = 72

export default function FirstQuestReveal({
  playerId,
  active,
}: {
  playerId: string
  active: boolean
}) {
  const [quest, setQuest] = useState<QuestRow | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!active) return

    const storageKey = `superhuman.first-quest-reveal:${playerId}`
    if (window.localStorage.getItem(storageKey) === 'seen') return

    let cancelled = false
    let pollCount = 0
    let timer: number | null = null
    const date = todayStr()

    async function inspectToday() {
      const { data, error } = await supabase
        .from('daily_quests')
        .select('id,title,kind,status')
        .eq('user_id', playerId)
        .eq('quest_date', date)
        .in('status', ['pending', 'partial'])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(8)

      if (cancelled || error) return
      const rows = (data ?? []) as QuestRow[]
      const firstQuest = rows.find(item => item.kind === 'main') ?? rows[0] ?? null

      if (firstQuest) {
        setQuest(firstQuest)
        setVisible(true)
        return
      }

      pollCount += 1
      if (pollCount < MAX_POLLS) timer = window.setTimeout(() => { void inspectToday() }, POLL_MS)
    }

    async function start() {
      const { count: priorCount, error: priorError } = await supabase
        .from('daily_quests')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', playerId)
        .lt('quest_date', date)

      if (cancelled || priorError) return
      if ((priorCount ?? 0) > 0) {
        window.localStorage.setItem(storageKey, 'seen')
        return
      }

      await inspectToday()
    }

    void start()

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [active, playerId])

  if (!active || !visible || !quest) return null

  const dismiss = () => {
    window.localStorage.setItem(`superhuman.first-quest-reveal:${playerId}`, 'seen')
    setVisible(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 68, pointerEvents: 'none', display: 'grid', alignItems: 'center', justifyItems: 'center', padding: '24px 16px 110px', boxSizing: 'border-box', background: 'linear-gradient(180deg,rgba(12,15,20,.34),rgba(12,15,20,.72))', backdropFilter: 'blur(3px)' }}>
      <section aria-label="First quest reveal" style={{ width: 'min(520px,100%)', pointerEvents: 'auto', border: `1px solid ${S.line}`, borderRadius: 22, padding: '28px 20px 20px', boxSizing: 'border-box', background: 'linear-gradient(145deg,#15140f,#10151d 68%)', boxShadow: '0 30px 90px rgba(0,0,0,.46), 0 0 42px rgba(246,178,75,.06)', textAlign: 'center', color: S.ink }}>
        <SystemMoment>
          <SystemPulse size={58} />
        </SystemMoment>
        <SystemMoment delay={130}>
          <div style={{ marginTop: 22 }}><SystemEyebrow>FIRST QUEST</SystemEyebrow></div>
        </SystemMoment>
        <SystemMoment delay={230}>
          <h2 style={{ margin: '14px auto 0', maxWidth: 430, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(30px,8vw,42px)', lineHeight: 1.02, letterSpacing: '-.045em' }}>Mulai dari ini.</h2>
        </SystemMoment>
        <SystemMoment delay={330}>
          <p style={{ margin: '16px auto 0', maxWidth: 430, color: S.gold, fontSize: 15, lineHeight: 1.5 }}>{quest.title}</p>
          <p style={{ margin: '9px auto 0', maxWidth: 400, color: S.muted, fontSize: 12.5, lineHeight: 1.55 }}>Nggak perlu gerakin semuanya. Satu langkah ini dulu.</p>
        </SystemMoment>
        <div style={{ marginTop: 24 }}><SystemLine compact /></div>
        <button type="button" onClick={dismiss} style={{ width: '100%', minHeight: 49, marginTop: 18, border: 0, borderRadius: 13, background: S.amber, color: S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', cursor: 'pointer' }}>
          LIHAT QUEST →
        </button>
      </section>
    </div>
  )
}
