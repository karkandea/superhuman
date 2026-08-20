'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useParams, usePathname, useRouter } from 'next/navigation'
import PlayerInitialization from './player-initialization'
import { ensurePlayerInitialization } from '@/lib/player-initialization-service'
import { supabase } from '@/lib/supabase'

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
      <div style={{ minHeight: '100dvh', background: '#0c0f14', display: 'grid', placeItems: 'center', color: loadError ? '#e5687a' : '#7e8795', fontFamily: '"IBM Plex Mono", monospace', padding: 24, textAlign: 'center' }}>
        {loadError ?? 'AUTHORIZING PLAYER...'}
      </div>
    )
  }

  return (
    <>
      {!initializationReady ? (
        <PlayerInitialization
          playerId={player.id}
          playerName={player.name}
          onReady={() => setInitializationReady(true)}
        />
      ) : children}

      <div style={{ position: 'fixed', right: 16, bottom: 'max(16px, env(safe-area-inset-bottom))', zIndex: 60, display: 'grid', justifyItems: 'end', gap: 6 }}>
        {logoutError && (
          <div role="status" style={{ background: '#181018', border: '1px solid #4b2c38', borderRadius: 9, padding: '7px 9px', color: '#e5687a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, boxShadow: '0 8px 24px rgba(0,0,0,.32)' }}>
            {logoutError}
          </div>
        )}
        <button
          type="button"
          onClick={() => { void logout() }}
          disabled={loggingOut}
          aria-label="Log out from Superhuman"
          style={{ border: '1px solid #303946', borderRadius: 10, background: 'rgba(12,15,20,.94)', padding: '9px 11px', color: loggingOut ? '#596270' : '#7e8795', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, letterSpacing: '.09em', cursor: loggingOut ? 'default' : 'pointer', boxShadow: '0 8px 24px rgba(0,0,0,.28)', backdropFilter: 'blur(10px)' }}
        >
          {loggingOut ? 'LOGGING OUT…' : 'LOG OUT'}
        </button>
      </div>
    </>
  )
}
