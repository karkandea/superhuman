'use client'

import type { ReactNode } from 'react'

const S = {
  panel: '#13171f',
  line: '#232a35',
  ink: '#ECEAE3',
  muted: '#7e8795',
  muted2: '#596270',
  amber: '#f6b24b',
  gold: '#ffd488',
} as const

function SystemAvatar({ size = 38 }: { size?: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 999,
        border: '1px solid rgba(246,178,75,.5)',
        background: 'radial-gradient(circle at 35% 30%, rgba(255,212,136,.22), rgba(246,178,75,.08) 42%, #11161e 72%)',
        boxShadow: '0 0 0 3px rgba(246,178,75,.04), 0 8px 24px rgba(0,0,0,.26)',
        color: S.gold,
        fontFamily: '"Space Grotesk", sans-serif',
        fontSize: Math.round(size * .38),
        fontWeight: 700,
        letterSpacing: '-.06em',
      }}
    >
      S
    </div>
  )
}

function PlayerAvatar({ size = 30 }: { size?: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 999,
        border: `1px solid ${S.line}`,
        background: '#171c24',
        color: S.muted,
      }}
    >
      <svg width={Math.round(size * .55)} height={Math.round(size * .55)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="3.4" />
        <path d="M5.5 19c.7-3.6 3-5.4 6.5-5.4s5.8 1.8 6.5 5.4" />
      </svg>
    </div>
  )
}

export default function ConversationHeader({
  playerName,
  statusLabel,
  onBack,
  action,
  progress,
  progressLabel,
}: {
  playerName: string
  statusLabel?: string
  onBack?: (() => void) | null
  action?: ReactNode
  progress?: number
  progressLabel?: string
}) {
  const boundedProgress = typeof progress === 'number' ? Math.min(100, Math.max(0, progress)) : null

  return (
    <header
      data-conversation-header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 40,
        background: 'rgba(12,15,20,.94)',
        backdropFilter: 'blur(18px)',
        borderBottom: `1px solid ${S.line}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 64, padding: '9px 2px' }}>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Kembali ke pertanyaan sebelumnya"
            style={{
              width: 34,
              height: 34,
              flex: '0 0 34px',
              display: 'grid',
              placeItems: 'center',
              border: `1px solid ${S.line}`,
              borderRadius: 999,
              background: S.panel,
              color: S.muted,
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            ←
          </button>
        ) : null}

        <SystemAvatar />

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: S.ink, fontFamily: '"Space Grotesk", sans-serif', fontSize: 15.5, fontWeight: 700, lineHeight: 1.15, letterSpacing: '-.02em' }}>
            Superhuman
          </div>
          <div style={{ marginTop: 3, color: S.amber, fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {statusLabel ?? 'AI PROGRESSION AGENT'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {action}
          <div data-player-identity style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, maxWidth: 150, padding: '4px 7px 4px 5px', border: `1px solid ${S.line}`, borderRadius: 999, background: 'rgba(19,23,31,.75)' }}>
            <PlayerAvatar />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: S.muted, fontSize: 10.5, fontWeight: 600 }}>
              {playerName}
            </span>
          </div>
        </div>
      </div>

      {boundedProgress !== null ? (
        <div style={{ paddingBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 5, color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.5, fontWeight: 700, letterSpacing: '.06em' }}>
            <span>CALIBRATION</span>
            {progressLabel ? <span>{progressLabel}</span> : null}
          </div>
          <div style={{ height: 2, borderRadius: 999, overflow: 'hidden', background: '#1b212a' }}>
            <div style={{ width: `${boundedProgress}%`, height: '100%', borderRadius: 999, background: S.amber, boxShadow: '0 0 12px rgba(246,178,75,.3)', transition: 'width 240ms ease' }} />
          </div>
        </div>
      ) : null}
    </header>
  )
}

export { PlayerAvatar, SystemAvatar }
