'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

const PRODUCTION_SITE_URL = 'https://superhuman.dualangka.com'
const MIN_PASSWORD_LENGTH = 8

function authRedirectUrl() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  return configured ? configured.replace(/\/+$/, '') : PRODUCTION_SITE_URL
}

function isPasswordRecoveryUrl() {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return params.get('type') === 'recovery'
}

function emailAuthError(error: { code?: string; status?: number; message?: string }) {
  if (error.status === 429 || error.code === 'over_email_send_rate_limit') {
    return 'Terlalu cepat meminta email baru. Tunggu beberapa detik lalu coba lagi.'
  }
  return 'Email login belum bisa dikirim. Coba lagi sebentar.'
}

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', red: '#e5687a',
} as const

export default function HomePage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [checking, setChecking] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [recoverySent, setRecoverySent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unlinkedEmail, setUnlinkedEmail] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function routeSignedInPlayer() {
      if (isPasswordRecoveryUrl()) {
        setRecoveryMode(true)
        setChecking(false)
        return
      }

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
        setError('Gagal memuat player profile. Coba refresh.')
        setChecking(false)
        return
      }

      if (!player) {
        setUnlinkedEmail(authData.user.email ?? 'akun ini')
        setChecking(false)
        return
      }

      router.replace(`/${encodeURIComponent(player.name)}`)
    }

    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true)
        setChecking(false)
        setError(null)
      }
    })

    void routeSignedInPlayer()
    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
    }
  }, [router])

  async function routeCurrentPlayer() {
    const { data: authData } = await supabase.auth.getUser()
    if (!authData.user) {
      router.replace('/')
      return
    }

    const { data: player } = await supabase
      .from('users')
      .select('name')
      .eq('id', authData.user.id)
      .maybeSingle()

    router.replace(player ? `/${encodeURIComponent(player.name)}` : '/')
  }

  async function signInWithPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || !password || submitting) return

    setSubmitting(true)
    setError(null)

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    })

    if (signInError) {
      setSubmitting(false)
      if (signInError.status === 429) {
        setError('Terlalu banyak percobaan login. Tunggu sebentar lalu coba lagi.')
      } else {
        setError('Email atau password salah. Kalau belum pernah bikin password, pilih SET / RESET PASSWORD.')
      }
      return
    }

    await routeCurrentPlayer()
  }

  async function sendPasswordRecovery() {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || submitting) {
      if (!normalizedEmail) setError('Masukkan email player dulu.')
      return
    }

    setSubmitting(true)
    setError(null)

    const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: authRedirectUrl(),
    })

    setSubmitting(false)

    if (recoveryError) {
      setError(emailAuthError(recoveryError))
      return
    }

    setRecoverySent(true)
  }

  async function setNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password minimal ${MIN_PASSWORD_LENGTH} karakter.`)
      return
    }

    if (password !== confirmPassword) {
      setError('Konfirmasi password belum sama.')
      return
    }

    setSubmitting(true)
    setError(null)

    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setSubmitting(false)
      setError(updateError.message || 'Password belum bisa disimpan. Coba lagi.')
      return
    }

    setPassword('')
    setConfirmPassword('')
    setRecoveryMode(false)
    await routeCurrentPlayer()
  }

  async function signOut() {
    await supabase.auth.signOut()
    setUnlinkedEmail(null)
    setRecoveryMode(false)
    setRecoverySent(false)
    setEmail('')
    setPassword('')
  }

  const inputStyle = {
    width: '100%', background: S.bg, border: `1px solid ${S.line}`, borderRadius: 10,
    padding: '11px 14px', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif',
    fontSize: 14, outline: 'none', boxSizing: 'border-box',
  } as const

  const buttonStyle = (disabled = false) => ({
    width: '100%', background: S.amber, border: 'none', borderRadius: 10,
    padding: '11px 18px', fontFamily: '"IBM Plex Mono", monospace',
    fontSize: 12, fontWeight: 600, color: S.bg, cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  } as const)

  const secondaryButtonStyle = (disabled = false) => ({
    ...buttonStyle(disabled),
    background: 'transparent', color: S.ink, border: `1px solid ${S.line}`,
  } as const)

  if (checking) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, display: 'grid', placeItems: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace' }}>
        AUTHENTICATING SYSTEM...
      </div>
    )
  }

  return (
    <div style={{ background: S.bg, minHeight: '100dvh', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, letterSpacing: '.18em', color: S.muted, textAlign: 'center', marginBottom: 8 }}>
          SUPERHUMAN SYSTEM
        </div>
        <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 28, textAlign: 'center', margin: '0 0 12px' }}>
          {recoveryMode ? 'Set Player Password' : 'Player Authentication'}
        </h1>
        <p style={{ color: S.muted, fontSize: 14, lineHeight: 1.5, textAlign: 'center', margin: '0 0 28px' }}>
          {recoveryMode
            ? 'Buat password untuk login berikutnya. Setelah ini lo nggak perlu minta magic link setiap masuk.'
            : 'Login utama sekarang pakai email + password. Email recovery hanya dibutuhkan saat setup atau lupa password.'}
        </p>

        <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: 20 }}>
          {unlinkedEmail ? (
            <>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.red, letterSpacing: '.08em', marginBottom: 10 }}>
                ACCOUNT NOT LINKED
              </div>
              <p style={{ margin: '0 0 16px', color: S.muted, fontSize: 14, lineHeight: 1.5 }}>
                {unlinkedEmail} berhasil login, tapi belum dipetakan ke player profile. Data tetap terkunci.
              </p>
              <button type="button" onClick={signOut} style={buttonStyle()}>
                SIGN OUT
              </button>
            </>
          ) : recoveryMode ? (
            <form onSubmit={setNewPassword}>
              <label htmlFor="new-password" style={{ display: 'block', fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, marginBottom: 10, letterSpacing: '.08em' }}>
                NEW PASSWORD
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder={`minimal ${MIN_PASSWORD_LENGTH} karakter`}
                style={inputStyle}
              />
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={confirmPassword}
                onChange={event => setConfirmPassword(event.target.value)}
                placeholder="ulang password"
                style={{ ...inputStyle, marginTop: 10 }}
              />
              {error && <div style={{ color: S.red, fontSize: 12, lineHeight: 1.45, marginTop: 10 }}>{error}</div>}
              <div style={{ marginTop: 12 }}>
                <button type="submit" disabled={submitting} style={buttonStyle(submitting)}>
                  {submitting ? 'SAVING...' : 'SAVE PASSWORD'}
                </button>
              </div>
            </form>
          ) : recoverySent ? (
            <>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.amber, letterSpacing: '.08em', marginBottom: 10 }}>
                PASSWORD EMAIL SENT
              </div>
              <p style={{ margin: '0 0 16px', color: S.muted, fontSize: 14, lineHeight: 1.5 }}>
                Buka email paling baru untuk set/reset password. Email itu sekali pakai; setelah password tersimpan, login berikutnya cukup pakai email + password.
              </p>
              <button type="button" onClick={() => setRecoverySent(false)} style={secondaryButtonStyle()}>
                BACK TO LOGIN
              </button>
            </>
          ) : (
            <form onSubmit={signInWithPassword}>
              <label htmlFor="email" style={{ display: 'block', fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, marginBottom: 10, letterSpacing: '.08em' }}>
                EMAIL + PASSWORD
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={event => setEmail(event.target.value)}
                placeholder="email player..."
                style={inputStyle}
              />
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="password"
                style={{ ...inputStyle, marginTop: 10 }}
              />
              {error && <div style={{ color: S.red, fontSize: 12, lineHeight: 1.45, marginTop: 10 }}>{error}</div>}
              <div style={{ marginTop: 12 }}>
                <button type="submit" disabled={submitting || !email.trim() || !password} style={buttonStyle(submitting || !email.trim() || !password)}>
                  {submitting ? 'SIGNING IN...' : 'SIGN IN'}
                </button>
              </div>
              <div style={{ marginTop: 10 }}>
                <button type="button" disabled={submitting} onClick={sendPasswordRecovery} style={secondaryButtonStyle(submitting)}>
                  SET / RESET PASSWORD
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
