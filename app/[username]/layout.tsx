'use client'

import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { useParams, usePathname, useRouter } from 'next/navigation'
import FirstQuestReveal from './first-quest-reveal'
import PlayerInitialization from './player-initialization'
import UpdateSystemComposer from './update-system-composer'
import { ensurePlayerInitialization } from '@/lib/player-initialization-service'
import { supabase } from '@/lib/supabase'

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35', ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

const VAULT_STARTER_PROMPTS = [
  'A goal changed: ',
  'Something happened: ',
  'I’m stuck on something: ',
  'About my life: ',
] as const

export default function PlayerRouteLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ username: string }>()
  const pathname = usePathname()
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)
  const [player, setPlayer] = useState<{ id: string; name: string } | null>(null)
  const [initializationReady, setInitializationReady] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function authorize() {
      const requestedUsername = decodeURIComponent(String(params.username))
      const { data: authData, error: authError } = await supabase.auth.getUser()

      if (cancelled) return
      if (authError || !authData.user) {
        router.replace('/')
        return
      }

      const { data: currentPlayer, error: playerError } = await supabase
        .from('users')
        .select('id,name')
        .eq('id', authData.user.id)
        .maybeSingle()

      if (cancelled) return
      if (playerError || !currentPlayer) {
        router.replace('/')
        return
      }

      if (currentPlayer.name.toLowerCase() !== requestedUsername.toLowerCase()) {
        const segments = pathname.split('/')
        segments[1] = encodeURIComponent(currentPlayer.name)
        router.replace(segments.join('/') || `/${encodeURIComponent(currentPlayer.name)}`)
        return
      }

      try {
        const initialization = await ensurePlayerInitialization(supabase)
        if (cancelled) return
        setPlayer({ id: currentPlayer.id, name: currentPlayer.name })
        setInitializationReady(initialization.readiness === 'ready')
        setAuthorized(true)
      } catch (error) {
        if (cancelled) return
        setLoadError(error instanceof Error ? error.message : 'Player initialization state could not load.')
        setAuthorized(true)
      }
    }

    void authorize()
    return () => { cancelled = true }
  }, [params.username, pathname, router])

  async function logout() {
    if (loggingOut) return
    setLoggingOut(true)
    setLogoutError(null)

    const { error } = await supabase.auth.signOut({ scope: 'local' })
    if (error) {
      setLoggingOut(false)
      setLogoutError('Logout gagal. Coba lagi.')
      return
    }

    router.replace('/')
    router.refresh()
  }

  if (!authorized || initializationReady === null || !player) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, display: 'grid', placeItems: 'center', color: loadError ? S.red : S.muted, fontFamily: '"IBM Plex Mono", monospace', padding: 24, textAlign: 'center' }}>
        {loadError ?? 'AUTHORIZING PLAYER...'}
      </div>
    )
  }

  if (!initializationReady) {
    return (
      <>
        <PlayerInitialization
          playerId={player.id}
          playerName={player.name}
          onReady={() => setInitializationReady(true)}
        />
        <LogoutControl loggingOut={loggingOut} logoutError={logoutError} onLogout={() => { void logout() }} />
      </>
    )
  }

  const basePath = `/${encodeURIComponent(player.name)}`
  const todayPath = basePath
  const vaultPath = `${basePath}/vault`
  const progressionPath = `${basePath}/history`
  const showComposer = pathname === todayPath || pathname === vaultPath

  const tabs = [
    { href: todayPath, label: 'Today', active: pathname === todayPath },
    { href: vaultPath, label: 'Vault', active: pathname === vaultPath },
    { href: progressionPath, label: 'Progression', active: pathname.startsWith(progressionPath) },
  ]

  return (
    <div style={{ minHeight: '100dvh', background: S.bg }}>
      <div style={{ paddingBottom: showComposer ? 164 : 76 }}>{children}</div>

      <FirstQuestReveal playerId={player.id} active={pathname === todayPath} />

      {showComposer && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(62px + env(safe-area-inset-bottom))', zIndex: 55, pointerEvents: 'none' }}>
          <div style={{ width: 'min(680px, 100%)', margin: '0 auto', padding: '0 12px 10px', boxSizing: 'border-box', pointerEvents: 'auto' }}>
            <UpdateSystemComposer playerId={player.id}
              starterPrompts={pathname === vaultPath ? VAULT_STARTER_PROMPTS : undefined}
            />
          </div>
        </div>
      )}

      <nav
        aria-label="Player navigation"
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 54,
          minHeight: 'calc(62px + env(safe-area-inset-bottom))',
          paddingBottom: 'env(safe-area-inset-bottom)', boxSizing: 'border-box',
          borderTop: `1px solid ${S.line}`, background: 'rgba(12,15,20,.96)', backdropFilter: 'blur(18px)',
          display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))',
        }}
      >
        {tabs.map(tab => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.active ? 'page' : undefined}
            style={{ minHeight: 62, display: 'grid', placeItems: 'center', textDecoration: 'none', color: tab.active ? S.gold : S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: tab.active ? 700 : 600, letterSpacing: '.035em', position: 'relative' }}
          >
            {tab.label}
            {tab.active && <span aria-hidden="true" style={{ position: 'absolute', top: 0, width: 28, height: 2, borderRadius: 99, background: S.amber, boxShadow: '0 0 12px rgba(246,178,75,.45)' }} />}
          </Link>
        ))}
      </nav>

      <LogoutControl loggingOut={loggingOut} logoutError={logoutError} onLogout={() => { void logout() }} />
    </div>
  )
}

function LogoutControl({
  loggingOut,
  logoutError,
  onLogout,
}: {
  loggingOut: boolean
  logoutError: string | null
  onLogout: () => void
}) {
  return (
    <div style={{ position: 'fixed', top: 'max(12px, env(safe-area-inset-top))', right: 12, zIndex: 70, display: 'grid', justifyItems: 'end', gap: 6 }}>
      {logoutError && (
        <div role="status" style={{ background: '#181018', border: '1px solid #4b2c38', borderRadius: 9, padding: '7px 9px', color: S.red, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, boxShadow: '0 8px 24px rgba(0,0,0,.32)' }}>
          {logoutError}
        </div>
      )}
      <button
        type="button"
        onClick={onLogout}
        disabled={loggingOut}
        aria-label="Log out from Superhuman"
        style={{ border: 0, borderRadius: 9, background: 'rgba(12,15,20,.72)', padding: '7px 9px', color: loggingOut ? S.muted2 : S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, fontWeight: 700, letterSpacing: '.07em', cursor: loggingOut ? 'default' : 'pointer', backdropFilter: 'blur(8px)' }}
      >
        {loggingOut ? 'LOGGING OUT…' : 'LOG OUT'}
      </button>
    </div>
  )
}
