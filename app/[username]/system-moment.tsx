'use client'

import type { ReactNode } from 'react'

const S = {
  line: '#232a35',
  amber: '#f6b24b',
  muted: '#7e8795',
  panel: '#13171f',
} as const

export function SystemPulse({ size = 58 }: { size?: number }) {
  return (
    <div aria-hidden="true" style={{ position: 'relative', width: size, height: size, margin: '0 auto' }}>
      <style>{`
        @keyframes superhuman-system-pulse {
          0%,100% { transform: scale(.78); opacity: .36; }
          50% { transform: scale(1); opacity: .95; }
        }
        @keyframes superhuman-system-scan {
          0% { transform: translateX(-100%); opacity: 0; }
          18% { opacity: .75; }
          82% { opacity: .75; }
          100% { transform: translateX(280%); opacity: 0; }
        }
        @keyframes superhuman-system-rise {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div style={{ position: 'absolute', inset: 0, borderRadius: 999, border: `1px solid ${S.line}`, background: S.panel }} />
      <div style={{ position: 'absolute', inset: size * .31, borderRadius: 999, background: S.amber, boxShadow: '0 0 26px rgba(246,178,75,.42)', animation: 'superhuman-system-pulse 2.4s ease-in-out infinite' }} />
    </div>
  )
}

export function SystemLine({ compact = false }: { compact?: boolean }) {
  return (
    <div aria-hidden="true" style={{ height: compact ? 2 : 3, borderRadius: 99, background: '#1b212a', overflow: 'hidden', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, width: '38%', borderRadius: 99, background: S.amber, boxShadow: '0 0 16px rgba(246,178,75,.32)', animation: 'superhuman-system-scan 2.8s ease-in-out infinite' }} />
    </div>
  )
}

export function SystemMoment({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <div style={{ animation: `superhuman-system-rise 520ms ease ${delay}ms both` }}>
      {children}
    </div>
  )
}

export function SystemEyebrow({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, fontWeight: 700, letterSpacing: '.17em' }}>
      {children}
    </div>
  )
}

export function WaitingCopy({ elapsedSeconds }: { elapsedSeconds: number }) {
  let copy = 'Jawaban lo udah masuk.'
  if (elapsedSeconds >= 8) copy = 'Lagi nyambungin polanya…'
  if (elapsedSeconds >= 26) copy = 'Masih jalan. Lo nggak perlu ngapa-ngapain.'
  if (elapsedSeconds >= 60) copy = 'Agak lebih lama dari biasanya. Jawaban lo aman.'

  return <span style={{ color: S.muted }}>{copy}</span>
}
