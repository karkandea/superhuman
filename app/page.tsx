'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b',
} as const

interface User { id: string; name: string }

export default function HomePage() {
  const router = useRouter()
  const [users,    setUsers]    = useState<User[]>([])
  const [loginName, setLoginName] = useState('')
  const [newName,  setNewName]  = useState('')
  const [loading,  setLoading]  = useState(true)
  const [adding,   setAdding]   = useState(false)
  const [busy,     setBusy]     = useState(false)

  useEffect(() => {
    supabase.from('users').select('id, name').order('created_at').then(({ data }) => {
      setUsers(data || [])
      setLoading(false)
    })
  }, [])

  // login user existing — cukup nama
  const login = async () => {
    const name = loginName.trim()
    if (!name) return
    setBusy(true)
    const { data } = await supabase
      .from('users').select('name').ilike('name', name).single()
    if (data) {
      router.push(`/${encodeURIComponent(data.name)}`)
    } else {
      alert('User belum ada. Tambahin dulu di bawah.')
      setBusy(false)
    }
  }

  const addUser = async () => {
    const name = newName.trim()
    if (!name) return
    setAdding(true)
    const { data, error } = await supabase.from('users').insert({ name }).select().single()
    if (!error && data) {
      router.push(`/${encodeURIComponent(data.name)}`)
    } else {
      alert('Nama sudah ada atau error. Coba nama lain.')
      setAdding(false)
    }
  }

  const inputStyle = {
    flex: 1, background: S.bg, border: `1px solid ${S.line}`, borderRadius: 10,
    padding: '10px 14px', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif',
    fontSize: 14, outline: 'none',
  } as const

  const btnStyle = (disabled: boolean) => ({
    background: S.amber, border: 'none', borderRadius: 10,
    padding: '10px 18px', fontFamily: '"IBM Plex Mono", monospace',
    fontSize: 12, fontWeight: 600, color: S.bg, cursor: 'pointer',
    opacity: disabled ? 0.5 : 1,
  } as const)

  return (
    <div style={{ background: S.bg, minHeight: '100dvh', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>

        <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, letterSpacing: '.18em', color: S.muted, textAlign: 'center', marginBottom: 8 }}>
          SUPERHUMAN CHECKLIST
        </div>
        <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 28, textAlign: 'center', margin: '0 0 32px' }}>
          Masuk dulu.
        </h1>

        {/* ── LOGIN ── */}
        <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, marginBottom: 12, letterSpacing: '.08em' }}>
            LOGIN — KETIK NAMA LO
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              value={loginName}
              onChange={e => setLoginName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && login()}
              placeholder="Nama lo..."
              style={inputStyle}
            />
            <button onClick={login} disabled={busy || !loginName.trim()} style={btnStyle(busy || !loginName.trim())}>
              {busy ? '...' : 'MASUK'}
            </button>
          </div>
        </div>

        {/* ── QUICK PICK ── */}
        {loading ? (
          <div style={{ textAlign: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, marginBottom: 16 }}>loading...</div>
        ) : users.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, marginBottom: 10, letterSpacing: '.08em', paddingLeft: 4 }}>
              ATAU PILIH CEPAT
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {users.map(u => (
                <button
                  key={u.id}
                  onClick={() => router.push(`/${encodeURIComponent(u.name)}`)}
                  style={{
                    background: S.panel, border: `1px solid ${S.line}`, borderRadius: 12,
                    padding: '14px 18px', textAlign: 'left', color: S.ink, cursor: 'pointer',
                    fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, fontSize: 15,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}
                >
                  {u.name}
                  <span style={{ color: S.amber }}>→</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── ADD USER ── */}
        <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: 20 }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, marginBottom: 12, letterSpacing: '.08em' }}>
            TAMBAH USER BARU
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addUser()}
              placeholder="Nama baru..."
              style={inputStyle}
            />
            <button onClick={addUser} disabled={adding || !newName.trim()} style={btnStyle(adding || !newName.trim())}>
              {adding ? '...' : 'ADD'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}