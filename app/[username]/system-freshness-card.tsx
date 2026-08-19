'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { requestDailyQuestGeneration } from '@/lib/ai/inference-job-service'
import { loadSystemFreshness, type SystemFreshnessSnapshot } from '@/lib/system-freshness-service'
import { supabase } from '@/lib/supabase'

const S = {
  panel: '#13171f', panel2: '#10141b', line: '#232a35', ink: '#ECEAE3', muted: '#7e8795',
  muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a', bg: '#0c0f14',
} as const

function timeLabel(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}

function toneColor(snapshot: SystemFreshnessSnapshot | null) {
  if (!snapshot) return S.muted
  if (snapshot.tone === 'danger') return S.red
  if (snapshot.tone === 'warm') return S.amber
  if (snapshot.tone === 'active') return S.gold
  return S.muted
}

export default function SystemFreshnessCard({
  playerId,
  date,
  refreshToken = 0,
  compact = false,
  onSettled,
}: {
  playerId: string | null
  date: string
  refreshToken?: number
  compact?: boolean
  onSettled?: () => void | Promise<void>
}) {
  const [snapshot, setSnapshot] = useState<SystemFreshnessSnapshot | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const previousPhaseRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    if (!playerId) return
    try {
      const next = await loadSystemFreshness(supabase, playerId, date)
      const previousPhase = previousPhaseRef.current
      previousPhaseRef.current = next.phase
      setSnapshot(next)
      setLoadError(false)

      if (
        previousPhase &&
        ['collecting', 'processing', 'saved'].includes(previousPhase) &&
        ['updated', 'no_change', 'interrupt'].includes(next.phase)
      ) {
        await onSettled?.()
      }
    } catch {
      setLoadError(true)
    }
  }, [date, onSettled, playerId])

  useEffect(() => {
    if (!playerId) return
    const first = window.setTimeout(() => { void refresh() }, 0)
    return () => window.clearTimeout(first)
  }, [playerId, refresh, refreshToken])

  useEffect(() => {
    if (!playerId) return
    const busy = snapshot?.isBusy ?? true
    const interval = window.setInterval(() => { void refresh() }, busy ? 3500 : 12000)
    return () => window.clearInterval(interval)
  }, [playerId, refresh, snapshot?.isBusy])

  async function retry() {
    if (!playerId || retrying) return
    setRetrying(true)
    try {
      await requestDailyQuestGeneration(supabase, date)
      await refresh()
    } finally {
      setRetrying(false)
    }
  }

  if (!playerId) return null

  if (!snapshot && !loadError) {
    return (
      <div style={{ minHeight: compact ? 54 : 86, border: `1px solid ${S.line}`, borderRadius: 14, background: S.panel2, display: 'flex', alignItems: 'center', padding: '0 13px', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5 }}>
        CHECKING SYSTEM STATUS…
      </div>
    )
  }

  if (loadError && !snapshot) {
    return (
      <div style={{ border: `1px solid ${S.line}`, borderRadius: 14, background: S.panel2, padding: '11px 13px', color: S.muted, fontSize: 11.5, lineHeight: 1.5 }}>
        System status could not refresh. Your saved data is unaffected.
      </div>
    )
  }

  if (!snapshot) return null
  const accent = toneColor(snapshot)

  return (
    <section
      aria-label="System freshness"
      style={{
        border: `1px solid ${snapshot.phase === 'interrupt' ? '#504326' : snapshot.phase === 'failure' ? '#482631' : S.line}`,
        borderRadius: 14,
        background: snapshot.phase === 'interrupt' ? 'linear-gradient(135deg,#17150f,#10141b)' : S.panel2,
        padding: compact ? '11px 12px' : '13px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: accent, fontSize: 8.5, fontWeight: 700, letterSpacing: '.12em' }}>{snapshot.eyebrow}</div>
          <div style={{ marginTop: 5, color: S.ink, fontSize: compact ? 12.5 : 13.5, fontWeight: 600, lineHeight: 1.35 }}>{snapshot.title}</div>
          {!compact && <div style={{ marginTop: 5, color: S.muted, fontSize: 11.5, lineHeight: 1.5 }}>{snapshot.detail}</div>}
        </div>
        {snapshot.isBusy && (
          <span aria-hidden="true" style={{ width: 8, height: 8, marginTop: 4, borderRadius: 99, background: accent, boxShadow: `0 0 0 5px ${snapshot.tone === 'active' ? 'rgba(255,212,136,.08)' : 'rgba(246,178,75,.08)'}`, flexShrink: 0 }} />
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: compact ? 8 : 11, paddingTop: compact ? 8 : 10, borderTop: `1px solid ${S.line}`, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>
            LAST UPDATE <span style={{ color: S.muted }}>{timeLabel(snapshot.lastUpdateAt)}</span>
          </div>
          <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>
            SYSTEM UNDERSTANDING <span style={{ color: S.muted }}>{snapshot.understandingUpdatedAt ? `UPDATED ${timeLabel(snapshot.understandingUpdatedAt)}` : '—'}</span>
          </div>
        </div>

        {snapshot.canRetry && (
          <button
            type="button"
            onClick={() => { void retry() }}
            disabled={retrying}
            style={{ minHeight: 34, border: `1px solid ${S.line}`, borderRadius: 9, background: S.panel, color: retrying ? S.muted2 : S.gold, padding: '0 10px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, letterSpacing: '.06em', cursor: retrying ? 'default' : 'pointer' }}
          >
            {retrying ? 'RETRYING…' : 'RETRY PROCESSING'}
          </button>
        )}
      </div>
    </section>
  )
}
