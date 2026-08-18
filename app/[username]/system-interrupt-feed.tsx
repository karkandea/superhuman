'use client'

import { useCallback, useEffect, useState } from 'react'
import { applySuggestedInterrupt, loadTodayInterrupts, type TodayInterrupt } from '@/lib/system-interrupt-service'
import { supabase } from '@/lib/supabase'

const S = {
  panel: '#13171f', line: '#232a35', ink: '#ECEAE3', muted: '#7e8795',
  amber: '#f6b24b', gold: '#ffd488', bg: '#0c0f14', red: '#e5687a',
} as const

function actionLabel(action: TodayInterrupt['actions'][number]) {
  if (action.action === 'add') return `ADDED · ${action.resultQuestTitle ?? 'New quest'}`
  if (action.action === 'replace') return `REPLACED · ${action.targetQuestTitle ?? 'Quest'}${action.resultQuestTitle ? ` → ${action.resultQuestTitle}` : ''}`
  if (action.action === 'defer') return `DEFERRED · ${action.targetQuestTitle ?? 'Quest'}`
  if (action.action === 'cancel') return `CANCELLED · ${action.targetQuestTitle ?? 'Quest'}`
  return `REPRIORITIZED · ${action.targetQuestTitle ?? 'Quest'}${action.newPriority ? ` → P${action.newPriority}` : ''}`
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
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!playerId) return
    try {
      const rows = await loadTodayInterrupts(supabase, playerId, date)
      setInterrupts(rows)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load System Interrupts')
    }
  }, [date, playerId])

  useEffect(() => {
    if (!playerId) return
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 4000)
    return () => window.clearInterval(timer)
  }, [playerId, refresh])

  const apply = useCallback(async (interruptId: string) => {
    if (applyingId) return
    setApplyingId(interruptId)
    setError(null)
    try {
      await applySuggestedInterrupt(supabase, interruptId)
      await Promise.all([refresh(), onApplied()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not apply adjustment')
    } finally {
      setApplyingId(null)
    }
  }, [applyingId, onApplied, refresh])

  if (!playerId || interrupts.length === 0) return null
  const latest = interrupts[0]
  const suggested = latest.status === 'suggested'

  return (
    <section style={{
      marginTop: 18,
      border: `1px solid ${suggested ? '#4c4128' : '#5a4826'}`,
      borderRadius: 18,
      padding: '17px 16px',
      background: suggested ? '#14150f' : 'linear-gradient(135deg,#17150f,#13171f)',
      boxShadow: suggested ? 'none' : '0 0 28px rgba(246,178,75,.07)',
    }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9, letterSpacing: '.15em' }}>
        {suggested ? 'SYSTEM SUGGESTION' : '⚠ SYSTEM INTERRUPT'}
      </div>
      <div style={{ marginTop: 8, color: S.ink, fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 17, lineHeight: 1.25 }}>
        {latest.summary}
      </div>
      <div style={{ marginTop: 8, color: S.muted, fontSize: 12, lineHeight: 1.55 }}>
        {latest.assessment.reason}
      </div>

      {latest.actions.length > 0 && (
        <div style={{ display: 'grid', gap: 7, marginTop: 13 }}>
          {latest.actions.map((action) => (
            <div key={action.id} style={{
              border: `1px solid ${S.line}`, borderRadius: 10, background: '#0f1319', padding: '9px 10px',
            }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontSize: 9, letterSpacing: '.08em' }}>
                {actionLabel(action)}
              </div>
              <div style={{ marginTop: 4, color: S.muted, fontSize: 10.5, lineHeight: 1.45 }}>{action.reason}</div>
            </div>
          ))}
        </div>
      )}

      {suggested && (
        <>
          <div style={{ marginTop: 11, color: S.muted, fontSize: 10.5, lineHeight: 1.5 }}>
            System melihat perubahan yang mungkin perlu menggeser prioritas, tapi confidence belum cukup tinggi untuk mengubah quest tanpa keputusan lo.
          </div>
          <button
            type="button"
            disabled={Boolean(applyingId)}
            onClick={() => { void apply(latest.id) }}
            style={{
              width: '100%', marginTop: 12, border: 'none', borderRadius: 10, padding: '11px 14px',
              background: S.amber, color: S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 10,
              fontWeight: 700, letterSpacing: '.08em', cursor: applyingId ? 'default' : 'pointer', opacity: applyingId ? .6 : 1,
            }}
          >
            {applyingId ? 'APPLYING...' : 'APPLY ADJUSTMENT'}
          </button>
        </>
      )}

      {error && process.env.NODE_ENV !== 'production' && (
        <div style={{ marginTop: 8, color: S.red, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>DEBUG · {error}</div>
      )}
    </section>
  )
}
