'use client'

import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

export default function PlayerHistoryLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ username: string }>()
  const pathname = usePathname()
  const username = decodeURIComponent(String(params.username))
  const onboardingPath = `/${encodeURIComponent(username)}/history/onboarding`
  const onOnboarding = pathname === onboardingPath

  return (
    <>
      {children}
      {!onOnboarding && (
        <Link
          href={onboardingPath}
          style={{ position: 'fixed', left: 14, top: 'max(12px, env(safe-area-inset-top))', zIndex: 45, border: '1px solid #232a35', borderRadius: 999, background: 'rgba(12,15,20,.78)', padding: '7px 10px', color: '#7e8795', textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, fontWeight: 700, letterSpacing: '.06em', backdropFilter: 'blur(10px)' }}
        >
          PLAYER ORIGIN
        </Link>
      )}
    </>
  )
}
