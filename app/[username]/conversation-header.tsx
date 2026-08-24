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

function SystemAvatar({ size = 38, active = false }: { size?: number; active?: boolean }) {
  return (
    <div
      data-superhuman-orb
      data-active={active ? 'true' : 'false'}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        position: 'relative',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 999,
        overflow: 'hidden',
        border: `1px solid ${active ? 'rgba(255,212,136,.72)' : 'rgba(246,178,75,.48)'}`,
        background: '#10141b',
        boxShadow: active
          ? '0 0 0 3px rgba(246,178,75,.07), 0 0 24px rgba(246,178,75,.28), 0 8px 24px rgba(0,0,0,.3)'
          : '0 0 0 3px rgba(246,178,75,.035), 0 8px 24px rgba(0,0,0,.26)',
        transition: 'border-color 220ms ease, box-shadow 220ms ease',
      }}
    >
      <style jsx>{`
        @keyframes superhumanOrbDrift {
          0% { transform: translate3d(-7%, -4%, 0) rotate(0deg) scale(1.02); }
          45% { transform: translate3d(7%, 5%, 0) rotate(155deg) scale(1.12); }
          100% { transform: translate3d(-7%, -4%, 0) rotate(360deg) scale(1.02); }
        }
        @keyframes superhumanOrbBreathe {
          0%, 100% { transform: scale(.88); opacity: .48; }
          50% { transform: scale(1.12); opacity: .88; }
        }
        @keyframes superhumanOrbActive {
          0%, 100% { transform: scale(.94); opacity: .68; }
          50% { transform: scale(1.2); opacity: 1; }
        }
        .orb-field {
          position: absolute;
          inset: -34%;
          border-radius: 42%;
          background:
            radial-gradient(circle at 30% 28%, rgba(255,239,193,.95), transparent 18%),
            radial-gradient(circle at 67% 39%, rgba(246,178,75,.92), transparent 30%),
            radial-gradient(circle at 48% 76%, rgba(165,86,24,.72), transparent 35%),
            conic-gradient(from 20deg, rgba(246,178,75,.08), rgba(255,212,136,.74), rgba(94,44,18,.32), rgba(246,178,75,.08));
          filter: blur(${Math.max(2, Math.round(size * .07))}px) saturate(1.12);
          animation: superhumanOrbDrift ${active ? '2.4s' : '6.8s'} linear infinite;
        }
        .orb-core {
          position: absolute;
          width: 52%;
          height: 52%;
          border-radius: 999px;
          background: radial-gradient(circle at 38% 30%, rgba(255,247,221,.98), rgba(255,201,108,.82) 28%, rgba(128,57,18,.28) 67%, transparent 72%);
          filter: blur(.4px);
          animation: ${active ? 'superhumanOrbActive 1.05s' : 'superhumanOrbBreathe 3.6s'} ease-in-out infinite;
        }
        .orb-glass {
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: radial-gradient(circle at 31% 24%, rgba(255,255,255,.22), transparent 29%), linear-gradient(145deg, rgba(255,255,255,.035), rgba(0,0,0,.18));
          box-shadow: inset 0 0 ${Math.round(size * .32)}px rgba(255,212,136,.15);
        }
        @media (prefers-reduced-motion: reduce) {
          .orb-field, .orb-core { animation: none !important; }
        }
      `}</style>
      <span className="orb-field" />
      <span className="orb-core" />
      <span className="orb-glass" />
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

function AgentTypingIndicator({ label = 'Superhuman lagi mikir' }: { label?: string }) {
  return (
    <div
      data-agent-typing
      role="status"
      aria-label={label}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 18 }}
    >
      <style jsx>{`
        @keyframes superhumanTypingWave {
          0%, 60%, 100% { transform: translateY(0); opacity: .42; }
          30% { transform: translateY(-4px); opacity: 1; }
        }
        .typing-dot {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: #ffd488;
          box-shadow: 0 0 8px rgba(246,178,75,.25);
          animation: superhumanTypingWave 1.05s ease-in-out infinite;
        }
        .typing-dot:nth-child(2) { animation-delay: .14s; }
        .typing-dot:nth-child(3) { animation-delay: .28s; }
        @media (prefers-reduced-motion: reduce) {
          .typing-dot { animation: none !important; opacity: .72; }
        }
      `}</style>
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
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
  agentActive = false,
}: {
  playerName: string
  statusLabel?: string
  onBack?: (() => void) | null
  action?: ReactNode
  progress?: number
  progressLabel?: string
  agentActive?: boolean
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

        <SystemAvatar active={agentActive} />

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: S.ink, fontFamily: '"Space Grotesk", sans-serif', fontSize: 15.5, fontWeight: 700, lineHeight: 1.15, letterSpacing: '-.02em' }}>
            Superhuman
          </div>
          <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, color: S.amber, fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span>{statusLabel ?? 'AI PROGRESSION AGENT'}</span>
            {agentActive ? <AgentTypingIndicator label="Superhuman sedang memproses" /> : null}
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

export { AgentTypingIndicator, PlayerAvatar, SystemAvatar }
