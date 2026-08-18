'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

const MIN_PASSWORD_LENGTH = 8
const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', red: '#e5687a',
} as const

export default function AccountPage() {
  const router = useRouter()
  const [checking, setChecking] = useState(true)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function verifySession() {
      const { data } = await supabase.auth.getUser()
      if (cancelled) return
      if (!data.user) {
        router.replace('/')
        return
      }
      setChecking(false)
    }

    void verifySession()
    return () => { cancelled = true }
  }, [router])

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password minimal ${MIN_PASSWORD_LENGTH} karakter.`)
      return
    }
    if (password !== confirmPassword) {
      setError('Konfirmasi password belum sama.')
      return
    }

    setSaving(true)
    setError(null)

    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setSaving(false)
      setError(updateError.message || 'Password belum bisa disimpan.')
      return
    }

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

  const inputStyle = {
    width: '100%', background: S.bg, border: `1px solid ${S.line}`, borderRadius: 10,
    padding: '11px 14px', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif',
    fontSize: 14, outline: 'none', boxSizing: 'border-box',
  } as const

  const buttonStyle = {
    width: '100%', background: S.amber, border: 'none', borderRadius: 10,
    padding: '11px 18px', fontFamily: '"IBM Plex Mono", monospace',
    fontSize: 12, fontWeight: 600, color: S.bg, cursor: saving ? 'default' : 'pointer',
    opacity: saving ? 0.5 : 1,
  } as const

  if (checking) {
    return <div style={{ minHeight: '100dvh', background: S.bg, display: 'grid', placeItems: 'center', color: S.muted }}>CHECKING SESSION...</div>
  }

  return (
    <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, display: 'grid', placeItems: 'center', padding: 24, fontFamily: '"IBM Plex Sans", sans-serif' }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, letterSpacing: '.18em', color: S.muted, textAlign: 'center', marginBottom: 8 }}>
          SUPERHUMAN SYSTEM
        </div>
        <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 28, textAlign: 'center', margin: '0 0 12px' }}>Change Password</h1>
        <p style={{ color: S.muted, fontSize: 14, lineHeight: 1.5, textAlign: 'center', margin: '0 0 28px' }}>
          Ganti temporary password dengan password pribadi. Proses ini tidak mengirim email.
        </p>
        <form onSubmit={savePassword} style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: 20 }}>
          <input type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required value={password} onChange={event => setPassword(event.target.value)} placeholder="password baru" style={inputStyle} />
          <input type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="ulang password baru" style={{ ...inputStyle, marginTop: 10 }} />
          {error && <div style={{ color: S.red, fontSize: 12, lineHeight: 1.45, marginTop: 10 }}>{error}</div>}
          <div style={{ marginTop: 12 }}>
            <button type="submit" disabled={saving} style={buttonStyle}>{saving ? 'SAVING...' : 'SAVE NEW PASSWORD'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
