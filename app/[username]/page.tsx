'use client'

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { CATEGORY_ORDER, CATEGORY_LABEL, Category, todayStr, toDateStr } from '@/lib/checklist-data'

const S = {
  bg: '#0c0f14', panel: '#13171f', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', gold: '#ffd488',
} as const

interface Item {
  id: string
  label: string
  category: Category
  anchor: boolean
  sort_order: number
}

function computeStreak(logs: { date: string; checked_ids: string[] }[], anchorIds: string[]) {
  const qualSet = new Set(
    logs.filter(l => anchorIds.length === 0 ? l.checked_ids.length > 0 : anchorIds.every(a => l.checked_ids.includes(a))).map(l => l.date)
  )
  let n = 0
  const cur = new Date()
  if (!qualSet.has(toDateStr(cur))) cur.setDate(cur.getDate() - 1)
  while (qualSet.has(toDateStr(cur))) { n++; cur.setDate(cur.getDate() - 1) }
  return n
}

const inputStyle = {
  width: '100%', background: S.bg, border: `1px solid ${S.line}`, borderRadius: 8,
  padding: '10px 12px', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif',
  fontSize: 14, outline: 'none',
} as const

const selectStyle = {
  background: S.bg, border: `1px solid ${S.line}`, borderRadius: 8,
  padding: '8px 10px', color: S.ink, fontFamily: '"IBM Plex Mono", monospace',
  fontSize: 11, outline: 'none',
} as const

export default function ChecklistPage() {
  const params   = useParams()
  const router   = useRouter()
  const username = decodeURIComponent(params.username as string)

  const [userId,   setUserId]   = useState<string | null>(null)
  const [items,    setItems]    = useState<Item[]>([])
  const [checked,  setChecked]  = useState<string[]>([])
  const [streak,   setStreak]   = useState(0)
  const [loading,  setLoading]  = useState(true)
  const [status,   setStatus]   = useState<'idle' | 'saving' | 'saved'>('idle')
  const [filter,   setFilter]   = useState<'semua' | Category>('semua')
  const [editMode, setEditMode] = useState(false)
  const [newLabel,    setNewLabel]    = useState('')
  const [newCategory, setNewCategory] = useState<Category>('pagi')
  const [newAnchor,   setNewAnchor]   = useState(false)

  const checkedRef = useRef<string[]>([])
  const saveTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  checkedRef.current = checked

  const anchorIds = useMemo(() => items.filter(i => i.anchor).map(i => i.id), [items])
  const total     = items.length

  const refreshStreak = useCallback(async (uid: string, anchors: string[]) => {
    const from60 = toDateStr(new Date(Date.now() - 60 * 864e5))
    const { data } = await supabase
      .from('daily_logs').select('date, checked_ids')
      .eq('user_id', uid).gte('date', from60)
    setStreak(computeStreak(data ?? [], anchors))
  }, [])

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null

    async function init() {
      const { data: user } = await supabase
        .from('users').select('id').eq('name', username).single()
      if (!user) { router.push('/'); return }
      setUserId(user.id)

      const { data: itemRows } = await supabase
        .from('checklist_items').select('id,label,category,anchor,sort_order')
        .eq('user_id', user.id).eq('is_deleted', false)
        .order('sort_order', { ascending: true })
      const activeItems = itemRows ?? []
      setItems(activeItems)

      const today = todayStr()
      const { data: log } = await supabase
        .from('daily_logs').select('checked_ids')
        .eq('user_id', user.id).eq('date', today).single()

      setChecked(log?.checked_ids ?? [])
      await refreshStreak(user.id, activeItems.filter(i => i.anchor).map(i => i.id))
      setLoading(false)

      channel = supabase
        .channel(`logs:${user.id}:${today}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'daily_logs', filter: `user_id=eq.${user.id}` },
          (payload) => {
            const row = payload.new as { date: string; checked_ids: string[] }
            if (row?.date === todayStr()) {
              const incoming = row.checked_ids ?? []
              const same = incoming.length === checkedRef.current.length && incoming.every(x => checkedRef.current.includes(x))
              if (!same) setChecked(incoming)
            }
          })
        .subscribe()
    }
    init()

    return () => { if (channel) supabase.removeChannel(channel) }
  }, [username, router, refreshStreak])

  const persist = useCallback((next: string[], itemCount: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setStatus('saving')
    saveTimer.current = setTimeout(async () => {
      const uid = userId
      if (!uid) return
      const { error } = await supabase.from('daily_logs').upsert(
        { user_id: uid, date: todayStr(), checked_ids: next, item_count: itemCount, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,date' }
      )
      if (!error) {
        setStatus('saved')
        refreshStreak(uid, anchorIds)
        setTimeout(() => setStatus('idle'), 1500)
      } else {
        setStatus('idle')
      }
    }, 500)
  }, [userId, refreshStreak, anchorIds])

  const toggle = useCallback((id: string) => {
    setChecked(prev => {
      const next = prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
      persist(next, total)
      return next
    })
  }, [persist, total])

  const resetDay = () => {
    setChecked([])
    persist([], total)
  }

  const addItem = async () => {
    if (!userId || !newLabel.trim()) return
    const { data } = await supabase.from('checklist_items').insert({
      user_id: userId, label: newLabel.trim(), category: newCategory,
      anchor: newAnchor, sort_order: items.length,
    }).select().single()
    if (data) {
      setItems(prev => [...prev, data])
      setNewLabel('')
      setNewAnchor(false)
    }
  }

  const deleteItem = async (id: string) => {
    if (!confirm('Hapus item ini? History lama tetep kesimpen kok.')) return
    await supabase.from('checklist_items').update({ is_deleted: true }).eq('id', id)
    setItems(prev => prev.filter(i => i.id !== id))
    setChecked(prev => {
      const next = prev.filter(c => c !== id)
      persist(next, total - 1)
      return next
    })
  }

  const updateItem = async (id: string, patch: Partial<Item>) => {
    await supabase.from('checklist_items').update(patch).eq('id', id)
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i))
  }

  const pct         = total ? Math.round((checked.length / total) * 100) : 0
  const p           = total ? checked.length / total : 0
  const anchorsDone = anchorIds.filter(a => checked.includes(a)).length
  const allAnchors  = anchorIds.length > 0 && anchorsDone === anchorIds.length

  const visibleCategories = filter === 'semua' ? CATEGORY_ORDER : [filter]

  if (loading) return (
    <div style={{ background: S.bg, minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace' }}>
      loading...
    </div>
  )

  return (
    <div style={{ background: S.bg, minHeight: '100dvh', color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 80 }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '0 18px' }}>

        <header style={{ padding: '34px 0 18px', textAlign: 'center' }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, letterSpacing: '.18em', textTransform: 'uppercase', color: S.muted }}>
            SELAMAT PAGI · {username.toUpperCase()}
          </div>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, color: S.muted, opacity: .7, marginTop: 4 }}>
            {new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
          <h1 style={{
            fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, lineHeight: 1.04,
            fontSize: 'clamp(26px,7vw,34px)', margin: '14px 0 2px', letterSpacing: '-.02em',
            color: p > 0.7 ? S.gold : S.ink,
            textShadow: p > 0.7 ? `0 0 ${18 * p}px rgba(255,212,136,${0.55 * p})` : 'none',
            transition: 'color 500ms ease',
          }}>
            Menangin Hari.
          </h1>

          <div style={{ display: 'flex', gap: 12, margin: '22px 0 6px' }}>
            <div style={{ flex: 1, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: '14px 16px' }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 600, fontSize: 26, color: p > 0.5 ? S.gold : S.ink }}>{pct}%</div>
              <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: S.muted }}>Hari ini</div>
            </div>
            <div style={{ flex: 1, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 16, padding: '14px 16px' }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 600, fontSize: 26, color: S.amber }}>{streak}</div>
              <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: S.muted }}>Streak hari</div>
            </div>
          </div>

          <div style={{ height: 6, borderRadius: 99, background: '#1c222c', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: `linear-gradient(90deg,${S.amber},${S.gold})`, transition: 'width 450ms ease' }} />
          </div>

          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, textAlign: 'center', margin: '14px 0 4px' }}>
            {allAnchors
              ? <span>⚡ <strong style={{ color: S.amber }}>jangkar kelar — hari ini lo menang.</strong></span>
              : <span>Jangkar wajib: <strong style={{ color: S.amber }}>{anchorsDone}/{anchorIds.length}</strong> kelar</span>
            }
          </div>

          <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, color: status === 'saved' ? S.amber : S.muted, opacity: status === 'idle' ? 0 : .9, height: 14, transition: 'opacity 300ms ease' }}>
            {status === 'saving' ? 'nyimpen…' : status === 'saved' ? '✓ tersimpan, sinkron semua device' : ''}
          </div>

          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 6 }}>
            <Link href={`/${encodeURIComponent(username)}/history`} style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.amber, textDecoration: 'none', letterSpacing: '.08em' }}>
              LIHAT HISTORY →
            </Link>
            <button onClick={() => setEditMode(v => !v)} style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: editMode ? S.gold : S.muted, background: 'none', border: 'none', letterSpacing: '.08em', cursor: 'pointer' }}>
              {editMode ? '✓ SELESAI EDIT' : '✏️ EDIT ITEM'}
            </button>
          </div>
        </header>

        {/* chips */}
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '4px 2px 18px' }}>
          {(['semua', ...CATEGORY_ORDER] as const).map(c => (
            <button key={c} onClick={() => setFilter(c)} style={{
              flexShrink: 0, padding: '8px 16px', borderRadius: 99, fontFamily: '"IBM Plex Mono", monospace',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: filter === c ? 'none' : `1px solid ${S.line}`,
              background: filter === c ? `linear-gradient(135deg,${S.amber},${S.gold})` : 'transparent',
              color: filter === c ? S.bg : S.muted,
            }}>
              {c === 'semua' ? 'Semua' : CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>

        <main>
          {visibleCategories.map(cat => {
            const catItems = items.filter(i => i.category === cat)
            if (!editMode && catItems.length === 0) return null
            return (
              <section key={cat} style={{ marginTop: 20 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 2px 10px' }}>
                  <span style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, fontSize: 16 }}>{CATEGORY_LABEL[cat]}</span>
                </div>
                <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, overflow: 'hidden' }}>
                  {catItems.length === 0 && (
                    <div style={{ padding: '16px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, textAlign: 'center' }}>
                      Belum ada item di kategori ini
                    </div>
                  )}
                  {catItems.map((item, idx) => {
                    const done = checked.includes(item.id)

                    if (editMode) {
                      return (
                        <div key={item.id} style={{ padding: '12px 16px', borderTop: idx === 0 ? 'none' : `1px solid ${S.line}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <input
                            defaultValue={item.label}
                            onBlur={e => { const v = e.target.value.trim(); if (v && v !== item.label) updateItem(item.id, { label: v }) }}
                            style={{ background: 'transparent', border: 'none', borderBottom: `1px solid ${S.line}`, color: S.ink, fontSize: 14, padding: '4px 0', outline: 'none', fontFamily: '"IBM Plex Sans", sans-serif' }}
                          />
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <select value={item.category} onChange={e => updateItem(item.id, { category: e.target.value as Category })} style={selectStyle}>
                              {CATEGORY_ORDER.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                            </select>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, color: S.muted }}>
                              <input type="checkbox" checked={item.anchor} onChange={e => updateItem(item.id, { anchor: e.target.checked })} />
                              WAJIB
                            </label>
                            <button onClick={() => deleteItem(item.id)} style={{ marginLeft: 'auto', background: 'none', border: `1px solid ${S.line}`, borderRadius: 8, color: '#e5687a', fontSize: 11, fontFamily: '"IBM Plex Mono", monospace', padding: '5px 10px', cursor: 'pointer' }}>
                              HAPUS
                            </button>
                          </div>
                        </div>
                      )
                    }

                    return (
                      <div
                        key={item.id}
                        onClick={() => toggle(item.id)}
                        role="checkbox"
                        aria-checked={done}
                        tabIndex={0}
                        onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(item.id) } }}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 13,
                          padding: '15px 16px', cursor: 'pointer', userSelect: 'none',
                          borderTop: idx === 0 ? 'none' : `1px solid ${S.line}`,
                          background: done ? 'rgba(246,178,75,0.03)' : 'transparent',
                        }}
                      >
                        <span style={{
                          flexShrink: 0, width: 22, height: 22, borderRadius: 7, marginTop: 1,
                          display: 'grid', placeItems: 'center',
                          border: done ? 'none' : '1.6px solid #39414e',
                          background: done ? `linear-gradient(135deg,${S.amber},${S.gold})` : 'transparent',
                          boxShadow: done ? '0 0 14px rgba(246,178,75,.55)' : 'none',
                        }}>
                          {done && (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={S.bg} strokeWidth="3.4">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </span>
                        <span style={{ fontSize: 14.5, lineHeight: 1.4, color: done ? S.muted : S.ink }}>
                          {item.label}
                          {item.anchor && (
                            <span style={{ display: 'inline-block', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, letterSpacing: '.1em', border: `1px solid rgba(246,178,75,.5)`, color: S.amber, borderRadius: 6, padding: '1px 5px', marginLeft: 7, verticalAlign: '1.5px' }}>WAJIB</span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}

          {editMode && (
            <section style={{ marginTop: 26 }}>
              <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, fontSize: 16, marginBottom: 10 }}>Tambah Item</div>
              <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && addItem()} placeholder="Nama checklist baru..." style={inputStyle} />
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={newCategory} onChange={e => setNewCategory(e.target.value as Category)} style={selectStyle}>
                    {CATEGORY_ORDER.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted }}>
                    <input type="checkbox" checked={newAnchor} onChange={e => setNewAnchor(e.target.checked)} />
                    Jangkar wajib
                  </label>
                  <button onClick={addItem} disabled={!newLabel.trim()} style={{ marginLeft: 'auto', background: S.amber, border: 'none', borderRadius: 10, padding: '9px 18px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, fontWeight: 600, color: S.bg, cursor: 'pointer', opacity: newLabel.trim() ? 1 : 0.5 }}>
                    ADD
                  </button>
                </div>
              </div>
            </section>
          )}
        </main>

        <footer style={{ marginTop: 30, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
          <button onClick={resetDay} style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, letterSpacing: '.08em', color: S.muted, background: 'none', border: `1px solid ${S.line}`, borderRadius: 99, padding: '8px 16px', cursor: 'pointer' }}>
            RESET HARI INI
          </button>
          <Link href="/" style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, textDecoration: 'none' }}>
            ← GANTI USER
          </Link>
        </footer>
      </div>
    </div>
  )
}
