'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { applySuggestedInterrupt, loadTodayInterrupts, type TodayInterrupt } from '@/lib/system-interrupt-service'
import { supabase } from '@/lib/supabase'

const S = {
  panel: '#13171f', line: '#232a35', ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270',
  amber: '#f6b24b', gold: '#ffd488', bg: '#0c0f14', red: '#e5687a',
} as const

function actionTitle(action: TodayInterrupt['actions'][number]) {
  if (action.action === 'add') return `New quest · ${action.resultQuestTitle ?? 'Added by the System'}`
  if (action.action === 'replace') return `Replaced · ${action.targetQuestTitle ?? 'Previous quest'}${action.resultQuestTitle ? ` → ${action.resultQuestTitle}` : ''}`
  if (action.action === 'defer') return `Moved out of today · ${action.targetQuestTitle ?? 'Quest'}`
  if (action.action === 'cancel') return `Cancelled today · ${action.targetQuestTitle ?? 'Quest'}`
  return `Priority updated · ${action.targetQuestTitle ?? 'Quest'}${action.newPriority ? ` → P${action.newPriority}` : ''}`
}

function seenStorageKey(playerId: string) {
  return `superhuman:seen-system-interrupts:${playerId}`
}

export default function SystemInterruptFeed({
  playerId,
  date,
  onApplied,
}: {
  playerId: string | null
  date: string
  onApplied: () => Promise<void>
}) {
  const [interrupts, setInterrupts] = useState<TodayInterrupt[]>([])
  const [seenAppliedIds, setSeenAppliedIds] = useState<Set<string>>(new Set())
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!playerId) return
    try {
      const parsed = JSON.parse(window.localStorage.getItem(seenStorageKey(playerId)) ?? '[]')
      setSeenAppliedIds(new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []))
    } catch {
      setSeenAppliedIds(new Set())
    }
  }, [playerId])

  const refresh = useCallback(async () => {
    if (!playerId) return
    try {
      const rows = await loadTodayInterrupts(supabase, playerId, date)
      setInterrupts(rows)
      setError(null)
    } catch {
      setError('System Interrupt could not refresh. Today’s quests were not changed by this error.')
    }
  }, [date, playerId])

  useEffect(() => {
    if (!playerId) return
    const first = window.setTimeout(() => { void refresh() }, 0)
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [playerId, refresh])

  const visibleInterrupts = useMemo(
    () => interrupts.filter((interrupt) => interrupt.status === 'suggested' || !seenAppliedIds.has(interrupt.id)),
    [interrupts, seenAppliedIds],
  )

  const latest = visibleInterrupts[0]

  const apply = useCallback(async (interruptId: string) => {
    if (applyingId) return
    setApplyingId(interruptId)
    setError(null)
    try {
      await applySuggestedInterrupt(supabase, interruptId)
      await Promise.all([refresh(), onApplied()])
    } catch {
      setError('Couldn’t apply this adjustment. Today’s current quests are still safe; try again when the System reconnects.')
    } finally {
      setApplyingId(null)
    }
  }, [applyingId, onApplied, refresh])

  function acknowledge(interruptId: string) {
    if (!playerId) return
    const next = new Set(seenAppliedIds)
    next.add(interruptId)
    setSeenAppliedIds(next)
    try {
      window.localStorage.setItem(seenStorageKey(playerId), JSON.stringify([...next]))
    } catch {
      // Local acknowledgement is convenience only; never block the product if storage is unavailable.
    }
  }

  if (!playerId || !latest) return error ? (
    <div role="status" style={{ marginTop: 14, border: `1px solid ${S.line}`, borderRadius: 12, background: '#171216', padding: '10px 12px', color: S.red, fontSize: 11.5, lineHeight: 1.5 }}>{error}</div>
  ) : null

  const suggested = latest.status === 'suggested'

  return (
    <section style={{
      marginTop: 16,
      border: '1px solid #5a4826',
      borderRadius: 18,
      padding: '17px 16px',
      background: 'linear-gradient(135deg,#18150d,#12151c)',
      boxShadow: '0 0 32px rgba(246,178,75,.07)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9, fontWeight: 700, letterSpacing: '.15em' }}>
          {suggested ? 'SYSTEM SUGGESTION' : '⚠ SYSTEM INTERRUPT'}
        </div>
        {!suggested && <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8.5 }}>TODAY CHANGED</div>}
      </div>

      <div style={{ marginTop: 8, color: S.ink, fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 18, lineHeight: 1.25 }}>
        {suggested ? 'New information may change today’s priority.' : 'New information changed today’s priority.'}
      </div>
      <div style={{ marginTop: 7, color: S.gold, fontSize: 13, lineHeight: 1.5 }}>{latest.summary}</div>
      <div style={{ marginTop: 6, color: S.muted, fontSize: 11.5, lineHeight: 1.55 }}>{latest.assessment.reason}</div>

      {latest.actions.length > 0 && (
        <div style={{ display: 'grid', gap: 7, marginTop: 13 }}>
          {latest.actions.map((action) => (
            <div key={action.id} style={{ border: `1px solid ${S.line}`, borderRadius: 10, background: '#0f1319', padding: '9px 10px' }}>
              <div style={{ color: S.ink, fontSize: 11.5, fontWeight: 600, lineHeight: 1.4 }}>{actionTitle(action)}</div>
              <div style={{ marginTop: 4, color: S.muted, fontSize: 10.5, lineHeight: 1.45 }}>{action.reason}</div>
            </div>
          ))}
        </div>
      )}

      {suggested ? (
        <>
          <div style={{ marginTop: 11, color: S.muted, fontSize: 10.5, lineHeight: 1.5 }}>
            System sees a meaningful change, but it will not move today’s quests until you approve the adjustment.
          </div>
          <button
            type="button"
            disabled={Boolean(applyingId)}
            onClick={() => { void apply(latest.id) }}
            style={{
              width: '100%', minHeight: 44, marginTop: 12, border: 'none', borderRadius: 10, padding: '0 14px',
              background: S.amber, color: S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5,
              fontWeight: 700, letterSpacing: '.08em', cursor: applyingId ? 'default' : 'pointer', opacity: applyingId ? .6 : 1,
            }}
          >
            {applyingId ? 'APPLYING…' : 'APPLY TODAY’S ADJUSTMENT'}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => acknowledge(latest.id)}
          style={{ marginTop: 12, minHeight: 40, border: `1px solid ${S.line}`, borderRadius: 10, background: S.panel, color: S.gold, padding: '0 13px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', cursor: 'pointer' }}
        >
          GOT IT
        </button>
      )}

      {error && <div role="status" style={{ marginTop: 9, color: S.red, fontSize: 10.5, lineHeight: 1.45 }}>{error}</div>}
    </section>
  )
}
