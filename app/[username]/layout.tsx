'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function PlayerRouteLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ username: string }>()
  const pathname = usePathname()
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)

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

      const { data: player, error: playerError } = await supabase
        .from('users')
        .select('id,name')
        .eq('id', authData.user.id)
        .maybeSingle()

      if (cancelled) return
      if (playerError || !player) {
        router.replace('/')
        return
      }

      if (player.name.toLowerCase() !== requestedUsername.toLowerCase()) {
        const segments = pathname.split('/')
        segments[1] = encodeURIComponent(player.name)
        router.replace(segments.join('/') || `/${encodeURIComponent(player.name)}`)
        return
      }

      setAuthorized(true)
    }

    void authorize()
    return () => { cancelled = true }
  }, [params.username, pathname, router])

  if (!authorized) {
    return (
      <div style={{ minHeight: '100dvh', background: '#0c0f14', display: 'grid', placeItems: 'center', color: '#7e8795', fontFamily: '"IBM Plex Mono", monospace' }}>
        AUTHORIZING PLAYER...
      </div>
    )
  }

  return children
}
