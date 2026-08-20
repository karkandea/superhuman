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
          style={{ position: 'fixed', right: 18, bottom: 74, zIndex: 30, border: '1px solid #303946', borderRadius: 999, background: 'rgba(16,20,27,.94)', padding: '9px 12px', color: '#ffd488', textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, letterSpacing: '.08em', boxShadow: '0 8px 24px rgba(0,0,0,.24)', backdropFilter: 'blur(10px)' }}
        >
          PLAYER ORIGIN
        </Link>
      )}
    </>
  )
}
