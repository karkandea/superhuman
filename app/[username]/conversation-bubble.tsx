'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { PlayerAvatar, SystemAvatar } from './conversation-header'

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
  collapsible = 'auto',
  collapseThreshold = 360,
  playerName = 'Player',
  systemActive = false,
}: {
  actor: 'system' | 'player'
  children: ReactNode
  meta?: ReactNode
  compact?: boolean
  collapsible?: boolean | 'auto'
  collapseThreshold?: number
  playerName?: string
  systemActive?: boolean
}) {
  const system = actor === 'system'
  const [expanded, setExpanded] = useState(false)
  const plainText = useMemo(() => typeof children === 'string' ? children.trim() : '', [children])
  const canCollapse = collapsible === true || (collapsible === 'auto' && plainText.length > collapseThreshold)
  const collapsed = canCollapse && !expanded

  return (
    <div
      data-conversation-bubble={actor}
      data-collapsible={canCollapse ? 'true' : 'false'}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: system ? 'flex-start' : 'flex-end',
        gap: compact ? 7 : 9,
      }}
    >
      {system ? <SystemAvatar size={compact ? 24 : 28} active={systemActive} /> : null}

      <div
        style={{
          width: 'fit-content',
          maxWidth: system ? 'min(84%, 560px)' : 'min(78%, 540px)',
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
          <span>{system ? 'SUPERHUMAN' : playerName}</span>
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
            boxShadow: system ? '0 9px 30px rgba(0,0,0,.12), inset 0 1px 0 rgba(255,255,255,.015)' : 'none',
          }}
        >
          <div style={{ position: 'relative' }}>
            <div
              style={{
                whiteSpace: 'pre-wrap',
                maxHeight: collapsed ? (compact ? 88 : 112) : 'none',
                overflow: collapsed ? 'hidden' : 'visible',
              }}
            >
              {children}
            </div>
            {collapsed ? (
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 38,
                  pointerEvents: 'none',
                  background: `linear-gradient(180deg, transparent, ${system ? S.panel : S.panel2})`,
                }}
              />
            ) : null}
          </div>

          {canCollapse ? (
            <button
              type="button"
              onClick={() => setExpanded(value => !value)}
              aria-expanded={expanded}
              style={{
                display: 'block',
                margin: '7px 0 -1px',
                border: 0,
                padding: '3px 0',
                background: 'transparent',
                color: system ? S.gold : S.muted,
                fontFamily: '"IBM Plex Mono", monospace',
                fontSize: 8.2,
                fontWeight: 700,
                letterSpacing: '.04em',
                cursor: 'pointer',
              }}
            >
              {expanded ? 'Ringkas ↑' : 'Lihat selengkapnya ↓'}
            </button>
          ) : null}
        </div>
      </div>

      {!system ? <PlayerAvatar size={compact ? 24 : 28} /> : null}
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
