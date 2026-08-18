'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', red: '#e5687a',
} as const

export default function HomePage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [checking, setChecking] = useState(true)
  const [sending, setSending] = useState(false)
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

    void routeSignedInPlayer()
    return () => { cancelled = true }
  }, [router])

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || sending) return

    setSending(true)
    setError(null)

    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin,
      },
    })

    setSending(false)

    if (signInError) {
      setError('Login belum bisa diproses. Pastikan email ini sudah terdaftar sebagai player.')
      return
    }

    setSent(true)
  }

  async function signOut() {
    await supabase.auth.signOut()
    setUnlinkedEmail(null)
    setSent(false)
    setEmail('')
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
          Player Authentication
        </h1>
        <p style={{ color: S.muted, fontSize: 14, lineHeight: 1.5, textAlign: 'center', margin: '0 0 28px' }}>
          Akses player sekarang terikat ke identity Supabase Auth, bukan sekadar username.
        </p>

        <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: 20 }}>
          {unlinkedEmail ? (
            <>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.red, letterSpacing: '.08em', marginBottom: 10 }}>
                ACCOUNT NOT LINKED
              </div>
              <p style={{ margin: '0 0 16px', color: S.muted, fontSize: 14, lineHeight: 1.5 }}>
                {unlinkedEmail} berhasil login, tapi belum dipetakan ke player profile legacy. Data tidak dibuka sampai mapping ownership selesai.
              </p>
              <button type="button" onClick={signOut} style={buttonStyle()}>
                SIGN OUT
              </button>
            </>
          ) : sent ? (
            <>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.amber, letterSpacing: '.08em', marginBottom: 10 }}>
                MAGIC LINK SENT
              </div>
              <p style={{ margin: '0 0 16px', color: S.muted, fontSize: 14, lineHeight: 1.5 }}>
                Cek inbox email lo dan buka magic link-nya. Link hanya akan bekerja untuk account player yang sudah diprovision.
              </p>
              <button type="button" onClick={() => setSent(false)} style={buttonStyle()}>
                GANTI EMAIL
              </button>
            </>
          ) : (
            <form onSubmit={sendMagicLink}>
              <label htmlFor="email" style={{ display: 'block', fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, marginBottom: 10, letterSpacing: '.08em' }}>
                LOGIN VIA MAGIC LINK
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
              {error && <div style={{ color: S.red, fontSize: 12, lineHeight: 1.45, marginTop: 10 }}>{error}</div>}
              <div style={{ marginTop: 12 }}>
                <button type="submit" disabled={sending || !email.trim()} style={buttonStyle(sending || !email.trim())}>
                  {sending ? 'SENDING...' : 'SEND MAGIC LINK'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
