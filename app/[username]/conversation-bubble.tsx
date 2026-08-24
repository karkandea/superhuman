import type { ReactNode } from 'react'

const S = {
  panel: '#13171f',
  panel2: '#10141b',
  line: '#232a35',
  ink: '#ECEAE3',
  muted: '#7e8795',
  muted2: '#596270',
  amber: '#f6b24b',
  gold: '#ffd488',
} as const

export default function ConversationBubble({
  actor,
  children,
  meta,
  compact = false,
}: {
  actor: 'system' | 'player'
  children: ReactNode
  meta?: ReactNode
  compact?: boolean
}) {
  const system = actor === 'system'
  return (
    <div
      data-conversation-bubble={actor}
      style={{
        width: 'fit-content',
        maxWidth: system ? '88%' : '82%',
        alignSelf: system ? 'flex-start' : 'flex-end',
        marginLeft: system ? 0 : 'auto',
        marginRight: system ? 'auto' : 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          margin: system ? '0 0 5px 3px' : '0 3px 5px 0',
          justifyContent: system ? 'flex-start' : 'flex-end',
          color: system ? S.gold : S.muted2,
          fontFamily: '"IBM Plex Mono", monospace',
          fontSize: 7.8,
          fontWeight: 700,
          letterSpacing: '.09em',
          textTransform: 'uppercase',
        }}
      >
        {system && <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 99, background: S.amber, boxShadow: '0 0 9px rgba(246,178,75,.45)' }} />}
        <span>{system ? 'SYSTEM' : 'PLAYER'}</span>
        {meta ? <span style={{ color: S.muted2, fontWeight: 600 }}>{meta}</span> : null}
      </div>
      <div
        style={{
          border: `1px solid ${system ? '#303744' : S.line}`,
          borderRadius: system ? '17px 17px 17px 6px' : '17px 17px 6px 17px',
          background: system ? S.panel : S.panel2,
          color: S.ink,
          padding: compact ? '9px 11px' : '11px 13px',
          fontSize: compact ? 12.5 : 13,
          lineHeight: 1.58,
          whiteSpace: 'pre-wrap',
          boxShadow: system ? '0 9px 30px rgba(0,0,0,.12), inset 0 1px 0 rgba(255,255,255,.015)' : 'none',
        }}
      >
        {children}
      </div>
    </div>
  )
}

export function ConversationStatus({ children }: { children: ReactNode }) {
  return (
    <div
      data-conversation-status
      aria-live="polite"
      style={{ display: 'flex', alignItems: 'center', gap: 9, color: S.muted, fontSize: 11.8, lineHeight: 1.5 }}
    >
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 99, background: S.amber, boxShadow: '0 0 12px rgba(246,178,75,.55)' }} />
      <span>{children}</span>
    </div>
  )
}
