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

  if (!authorized || initializationReady === null || !player) {
    return (
      <div style={{ minHeight: '100dvh', background: '#0c0f14', display: 'grid', placeItems: 'center', color: loadError ? '#e5687a' : '#7e8795', fontFamily: '"IBM Plex Mono", monospace', padding: 24, textAlign: 'center' }}>
        {loadError ?? 'AUTHORIZING PLAYER...'}
      </div>
    )
  }

  if (!initializationReady) {
    return (
      <PlayerInitialization
        playerId={player.id}
        playerName={player.name}
        onReady={() => setInitializationReady(true)}
      />
    )
  }

  return children
}
