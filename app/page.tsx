'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

const PRODUCTION_SITE_URL = 'https://superhuman.dualangka.com'
const MIN_PLAYER_NAME_LENGTH = 2
const MAX_PLAYER_NAME_LENGTH = 32

type AuthMode = 'login' | 'register'
type AuthMethod = 'magic' | 'password'

function authRedirectUrl() {
  return PRODUCTION_SITE_URL
}

function normalizedPlayerName(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function playerNameError(value: string) {
  const normalized = normalizedPlayerName(value)
  if (normalized.length < MIN_PLAYER_NAME_LENGTH || normalized.length > MAX_PLAYER_NAME_LENGTH) {
    return `Nama player harus ${MIN_PLAYER_NAME_LENGTH}-${MAX_PLAYER_NAME_LENGTH} karakter.`
  }
  if (!/^[A-Za-z0-9._ -]+$/.test(normalized)) {
    return 'Nama player hanya boleh huruf, angka, spasi, titik, underscore, atau dash.'
  }
  return null
}

function emailError(error: { code?: string; status?: number; message?: string }) {
  if (error.status === 429 || error.code === 'over_email_send_rate_limit') {
    return 'Terlalu cepat meminta link baru. Coba lagi sebentar.'
  }
  if (error.message?.toLowerCase().includes('signups not allowed')) return 'Registrasi baru sedang ditutup.'
  return 'Email belum bisa dikirim. Coba lagi.'
}

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35', ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

export default function HomePage() {
  const router = useRouter()
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('magic')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [playerName, setPlayerName] = useState('')
  const [checking, setChecking] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unlinkedEmail, setUnlinkedEmail] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function routeSignedInPlayer() {
      const { data: authData, error: authError } = await supabase.auth.getUser()
      if (cancelled) return
      if (authError || !authData.user) {
        setChecking(false)
        return
      }

      const { data: player, error: playerError } = await supabase
        .from('users')
        .select('name')
        .eq('id', authData.user.id)
        .maybeSingle()
      if (cancelled) return

      if (playerError) {
        setError('Player profile belum bisa dimuat. Coba refresh.')
        setChecking(false)
        return
      }
      if (player) {
        router.replace(`/${encodeURIComponent(player.name)}`)
        return
      }

      const metadataName = typeof authData.user.user_metadata?.player_name === 'string'
        ? normalizedPlayerName(authData.user.user_metadata.player_name)
        : ''
      if (metadataName && !playerNameError(metadataName)) {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
        const { error: insertError } = await supabase
          .from('users')
          .insert({ id: authData.user.id, name: metadataName, timezone })
        if (!insertError) {
          router.replace(`/${encodeURIComponent(metadataName)}`)
          return
        }
        if (insertError.code === '23505') setError('Nama player ini sudah dipakai. Pilih nama lain.')
        else setError('Account sudah masuk, tapi player profile belum bisa dibuat.')
      }

      setPlayerName(metadataName)
      setUnlinkedEmail(authData.user.email ?? 'akun ini')
      setChecking(false)
    }

    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') window.setTimeout(() => { void routeSignedInPlayer() }, 0)
    })

    void routeSignedInPlayer()
    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
    }
  }, [router])

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) return

    const normalizedName = normalizedPlayerName(playerName)
    if (authMode === 'register') {
      const nameError = playerNameError(normalizedName)
      if (nameError) {
        setError(nameError)
        return
      }
    }

    setSubmitting(true)
    setError(null)
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo: authRedirectUrl(),
        shouldCreateUser: authMode === 'register',
        ...(authMode === 'register' ? { data: { player_name: normalizedName } } : {}),
      },
    })
    setSubmitting(false)

    if (signInError) {
      setError(emailError(signInError))
      return
    }
    setSent(true)
  }

  async function signInWithPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || !password) return

    setSubmitting(true)
    setError(null)
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    })
    setSubmitting(false)

    if (signInError) {
      setError('Email atau password nggak cocok.')
      return
    }
  }

  async function createPlayerProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    const normalizedName = normalizedPlayerName(playerName)
    const nameError = playerNameError(normalizedName)
    if (nameError) {
      setError(nameError)
      return
    }

    setSubmitting(true)
    setError(null)
    const { data: authData } = await supabase.auth.getUser()
    if (!authData.user) {
      setSubmitting(false)
      setError('Session sudah berakhir. Sign in lagi.')
      return
    }

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
    const { error: insertError } = await supabase
      .from('users')
      .insert({ id: authData.user.id, name: normalizedName, timezone })
    setSubmitting(false)

    if (insertError) {
      setError(insertError.code === '23505' ? 'Nama player ini sudah dipakai. Pilih nama lain.' : 'Player profile belum bisa dibuat. Coba lagi.')
      return
    }
    router.replace(`/${encodeURIComponent(normalizedName)}`)
  }

  async function signOut() {
    await supabase.auth.signOut({ scope: 'local' })
    setUnlinkedEmail(null)
    setSent(false)
    setError(null)
  }

  function switchMode(mode: AuthMode) {
    setAuthMode(mode)
    setAuthMethod('magic')
    setPassword('')
    setSent(false)
    setError(null)
  }

  function switchMethod(method: AuthMethod) {
    setAuthMethod(method)
    setPassword('')
    setSent(false)
    setError(null)
  }

  if (checking) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, display: 'grid', placeItems: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, letterSpacing: '.08em' }}>
        OPENING SYSTEM…
      </div>
    )
  }

  const inputStyle = {
    width: '100%', boxSizing: 'border-box' as const, minHeight: 50, background: '#0f1319', border: `1px solid ${S.line}`, borderRadius: 12,
    padding: '0 14px', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 15, outline: 'none',
  }

  return (
    <main style={{ minHeight: '100dvh', background: S.bg, color: S.ink, display: 'grid', placeItems: 'center', padding: '28px 20px', fontFamily: '"IBM Plex Sans", sans-serif' }}>
      <div style={{ width: '100%', maxWidth: 390 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, fontWeight: 700, letterSpacing: '.2em', color: S.amber }}>SUPERHUMAN</div>
          <h1 style={{ margin: '11px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(30px,9vw,40px)', lineHeight: 1, letterSpacing: '-.04em' }}>Your System is waiting.</h1>
        </div>

        <div style={{ marginTop: 30, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, padding: '18px' }}>
          {unlinkedEmail ? (
            <form onSubmit={createPlayerProfile}>
              <div style={{ color: S.muted, fontSize: 12.5, lineHeight: 1.5 }}>One last thing — choose your player name.</div>
              <input type="text" autoComplete="nickname" required minLength={MIN_PLAYER_NAME_LENGTH} maxLength={MAX_PLAYER_NAME_LENGTH} value={playerName} onChange={event => setPlayerName(event.target.value)} placeholder="Player name" style={{ ...inputStyle, marginTop: 13 }} />
              {error && <div role="alert" style={{ color: S.red, fontSize: 11.5, lineHeight: 1.45, marginTop: 9 }}>{error}</div>}
              <button type="submit" disabled={submitting} style={{ width: '100%', minHeight: 48, marginTop: 12, border: 0, borderRadius: 12, background: submitting ? '#3a3328' : S.amber, color: S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 800, cursor: submitting ? 'default' : 'pointer' }}>{submitting ? 'CREATING…' : 'CONTINUE'}</button>
              <button type="button" onClick={() => { void signOut() }} style={{ width: '100%', minHeight: 38, marginTop: 7, border: 0, background: 'transparent', color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: 'pointer' }}>SIGN OUT</button>
            </form>
          ) : sent ? (
            <div style={{ textAlign: 'center', padding: '8px 2px' }}>
              <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 22, fontWeight: 700 }}>Check your email.</div>
              <p style={{ margin: '8px 0 0', color: S.muted, fontSize: 13, lineHeight: 1.55 }}>We sent you a secure sign-in link.</p>
              <button type="button" onClick={() => { setSent(false); setError(null) }} style={{ minHeight: 38, marginTop: 14, border: 0, background: 'transparent', color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: 'pointer' }}>USE ANOTHER EMAIL</button>
            </div>
          ) : authMode === 'login' && authMethod === 'password' ? (
            <form onSubmit={signInWithPassword}>
              <div style={{ marginBottom: 13, color: S.muted, fontSize: 12.5, lineHeight: 1.5 }}>Sign in with your existing password.</div>
              <input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="Email" style={inputStyle} />
              <input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="Password" style={{ ...inputStyle, marginTop: 10 }} />
              {error && <div role="alert" style={{ color: S.red, fontSize: 11.5, lineHeight: 1.45, marginTop: 9 }}>{error}</div>}
              <button type="submit" disabled={submitting || !email.trim() || !password} style={{ width: '100%', minHeight: 48, marginTop: 12, border: 0, borderRadius: 12, background: submitting || !email.trim() || !password ? '#3a3328' : S.amber, color: submitting || !email.trim() || !password ? S.muted : S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 800, cursor: submitting ? 'default' : 'pointer' }}>{submitting ? 'SIGNING IN…' : 'SIGN IN'}</button>
              <button type="button" disabled={submitting} onClick={() => switchMethod('magic')} style={{ width: '100%', minHeight: 40, marginTop: 8, border: 0, background: 'transparent', color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: submitting ? 'default' : 'pointer' }}>EMAIL ME A SIGN-IN LINK</button>
              <button type="button" disabled={submitting} onClick={() => switchMode('register')} style={{ width: '100%', minHeight: 38, border: 0, background: 'transparent', color: S.muted, fontSize: 12, cursor: submitting ? 'default' : 'pointer' }}>New here? Create your System</button>
            </form>
          ) : (
            <form onSubmit={sendMagicLink}>
              {authMode === 'register' && (
                <input type="text" autoComplete="nickname" required minLength={MIN_PLAYER_NAME_LENGTH} maxLength={MAX_PLAYER_NAME_LENGTH} value={playerName} onChange={event => setPlayerName(event.target.value)} placeholder="Player name" style={inputStyle} />
              )}
              <input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="Email" style={{ ...inputStyle, marginTop: authMode === 'register' ? 10 : 0 }} />
              {error && <div role="alert" style={{ color: S.red, fontSize: 11.5, lineHeight: 1.45, marginTop: 9 }}>{error}</div>}
              <button type="submit" disabled={submitting || !email.trim()} style={{ width: '100%', minHeight: 48, marginTop: 12, border: 0, borderRadius: 12, background: submitting || !email.trim() ? '#3a3328' : S.amber, color: submitting || !email.trim() ? S.muted : S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 800, cursor: submitting ? 'default' : 'pointer' }}>{submitting ? 'SENDING…' : authMode === 'register' ? 'CREATE SYSTEM' : 'CONTINUE'}</button>
              {authMode === 'login' && (
                <button type="button" disabled={submitting} onClick={() => switchMethod('password')} style={{ width: '100%', minHeight: 40, marginTop: 8, border: 0, background: 'transparent', color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: submitting ? 'default' : 'pointer' }}>USE PASSWORD</button>
              )}
              <button type="button" disabled={submitting} onClick={() => switchMode(authMode === 'login' ? 'register' : 'login')} style={{ width: '100%', minHeight: 40, border: 0, background: 'transparent', color: S.muted, fontSize: 12, cursor: submitting ? 'default' : 'pointer' }}>
                {authMode === 'login' ? 'New here? Create your System' : 'Already have a System? Sign in'}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  )
}
