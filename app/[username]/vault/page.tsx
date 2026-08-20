'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { requestDailyQuestGeneration } from '@/lib/ai/inference-job-service'
import { todayStr } from '@/lib/checklist-data'
import { supabase } from '@/lib/supabase'

interface VaultEntry {
  id: string
  raw_text: string
  content_metadata: Record<string, unknown>
  processing_status: string
  occurred_at: string | null
  created_at: string
}

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

function isFoundationUnavailable(message: string) {
  const value = message.toLowerCase()
  return value.includes('knowledge_entries') || value.includes('schema cache')
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatDuration(ms: number | null) {
  if (!ms) return null
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function dateKey(value: string) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function groupLabel(key: string) {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const todayKey = dateKey(today.toISOString())
  const yesterdayKey = dateKey(yesterday.toISOString())
  if (key === todayKey) return 'Today'
  if (key === yesterdayKey) return 'Yesterday'
  const date = new Date(`${key}T12:00:00`)
  return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function entryDisplay(entry: VaultEntry) {
  const metadata = entry.content_metadata ?? {}
  const input = asString(metadata.input)
  const answerMode = asString(metadata.answerMode)
  const voice = input === 'voice' || answerMode === 'audio'
  const duration = formatDuration(asNumber(metadata.durationMs))
  const transcriptReady = asString(metadata.transcriptStatus) === 'ready' || (voice && !entry.raw_text.includes('transcript is pending'))
  const fileName = asString(metadata.fileName)
  const extension = asString(metadata.fileExtension)

  if (voice) {
    return {
      eyebrow: `🎙 Voice update${duration ? ` · ${duration}` : ''}`,
      text: transcriptReady ? entry.raw_text : '',
      fileName: null,
    }
  }
  if (fileName) {
    return {
      eyebrow: extension ? extension.toUpperCase() : 'FILE',
      text: entry.raw_text,
      fileName,
    }
  }
  return { eyebrow: 'Update', text: entry.raw_text, fileName: null }
}

export default function LifeVaultPage() {
  const router = useRouter()
  const params = useParams<{ username: string }>()
  const username = decodeURIComponent(params.username)

  const [playerId, setPlayerId] = useState<string | null>(null)
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [understandingUpdatedAt, setUnderstandingUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [foundationReady, setFoundationReady] = useState(true)
  const [retrying, setRetrying] = useState(false)

  const loadEntries = useCallback(async (id: string) => {
    const [knowledgeResult, briefResult] = await Promise.all([
      supabase
        .from('knowledge_entries')
        .select('id,raw_text,content_metadata,processing_status,occurred_at,created_at')
        .eq('user_id', id)
        .order('created_at', { ascending: false })
        .limit(60),
      supabase
        .from('player_briefs')
        .select('created_at')
        .eq('user_id', id)
        .eq('is_current', true)
        .maybeSingle(),
    ])

    if (knowledgeResult.error) {
      if (isFoundationUnavailable(knowledgeResult.error.message)) {
        setFoundationReady(false)
        setEntries([])
        return
      }
      throw knowledgeResult.error
    }
    if (briefResult.error) throw briefResult.error

    setFoundationReady(true)
    setEntries((knowledgeResult.data ?? []) as VaultEntry[])
    setUnderstandingUpdatedAt(briefResult.data?.created_at ?? null)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const { data: authData, error: authError } = await supabase.auth.getUser()
        if (authError || !authData.user) {
          router.replace('/')
          return
        }
        const { data: profile, error: profileError } = await supabase
          .from('users')
          .select('id,name')
          .eq('id', authData.user.id)
          .maybeSingle()
        if (profileError) throw profileError
        if (!profile) {
          router.replace('/')
          return
        }
        if (profile.name.toLowerCase() !== username.toLowerCase()) {
          router.replace(`/${encodeURIComponent(profile.name)}/vault`)
          return
        }
        if (cancelled) return
        setPlayerId(profile.id)
        await loadEntries(profile.id)
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : 'Failed to load Life Vault')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void boot()
    return () => { cancelled = true }
  }, [loadEntries, router, username])

  useEffect(() => {
    if (!playerId) return
    const handleSaved = () => { void loadEntries(playerId).catch(() => {}) }
    window.addEventListener('superhuman:knowledge-saved', handleSaved)
    const timer = window.setInterval(handleSaved, 12000)
    return () => {
      window.removeEventListener('superhuman:knowledge-saved', handleSaved)
      window.clearInterval(timer)
    }
  }, [loadEntries, playerId])

  const groups = useMemo(() => {
    const map = new Map<string, VaultEntry[]>()
    for (const entry of entries) {
      const key = dateKey(entry.occurred_at ?? entry.created_at)
      const list = map.get(key) ?? []
      list.push(entry)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [entries])

  async function retryProcessing() {
    if (retrying) return
    setRetrying(true)
    setMessage('')
    try {
      await requestDailyQuestGeneration(supabase, todayStr())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Couldn’t retry System processing.')
    } finally {
      setRetrying(false)
    }
  }

  if (loading) {
    return <main style={{ minHeight: '100dvh', background: S.bg, color: S.muted, display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, letterSpacing: '.1em' }}>LOADING VAULT…</main>
  }

  const hasFailedEntry = entries.some(entry => entry.processing_status === 'failed')

  return (
    <main style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif' }}>
      <div style={{ width: '100%', maxWidth: 680, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '30px 0 24px' }}>
          <h1 style={{ margin: 0, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(34px,9vw,46px)', lineHeight: 1, letterSpacing: '-.045em' }}>Life Vault</h1>
          <p style={{ margin: '9px 0 0', color: S.muted, fontSize: 13, lineHeight: 1.55 }}>Everything the System knows from what you’ve shared.</p>
          <div style={{ marginTop: 13, fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8.5, letterSpacing: '.04em' }}>
            SYSTEM UNDERSTANDING · {understandingUpdatedAt ? `UPDATED ${new Date(understandingUpdatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : 'BUILDING'}
          </div>
        </header>

        {!foundationReady && (
          <div style={{ border: '1px solid #4a3a21', background: '#17140f', borderRadius: 13, padding: '12px 13px', color: '#d7bd8c', fontSize: 11.5, lineHeight: 1.5 }}>
            Life Vault belum bisa reconnect. Existing knowledge tetap aman.
          </div>
        )}

        {message && <div role="status" style={{ marginBottom: 13, color: S.red, fontSize: 11.5, lineHeight: 1.5 }}>{message}</div>}

        {hasFailedEntry && (
          <div style={{ marginBottom: 18, padding: '10px 0', borderTop: `1px solid ${S.line}`, borderBottom: `1px solid ${S.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ color: S.muted, fontSize: 11.5 }}>One saved update still needs processing.</span>
            <button type="button" onClick={() => { void retryProcessing() }} disabled={retrying} style={{ border: 0, background: 'transparent', color: S.gold, padding: 4, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: retrying ? 'default' : 'pointer' }}>{retrying ? 'RETRYING…' : 'RETRY'}</button>
          </div>
        )}

        <section>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.13em', marginBottom: 16 }}>RECENT KNOWLEDGE</div>

          {entries.length === 0 ? (
            <div style={{ padding: '28px 0', borderTop: `1px solid ${S.line}`, color: S.muted, fontSize: 12.5, lineHeight: 1.55 }}>
              Tell the System something. Your first update will appear here.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 27 }}>
              {groups.map(([key, items]) => (
                <section key={key}>
                  <h2 style={{ margin: '0 0 8px', fontFamily: '"Space Grotesk", sans-serif', fontSize: 17, color: S.ink, fontWeight: 650 }}>{groupLabel(key)}</h2>
                  <div style={{ borderTop: `1px solid ${S.line}` }}>
                    {items.map(entry => {
                      const display = entryDisplay(entry)
                      const when = new Date(entry.occurred_at ?? entry.created_at)
                      return (
                        <article key={entry.id} style={{ padding: '13px 1px 14px', borderBottom: `1px solid ${S.line}` }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ minWidth: 0, color: display.eyebrow.startsWith('🎙') ? S.gold : S.muted, fontFamily: display.eyebrow.startsWith('🎙') ? '"IBM Plex Sans", sans-serif' : '"IBM Plex Mono", monospace', fontSize: display.eyebrow.startsWith('🎙') ? 12.5 : 8.5, letterSpacing: display.eyebrow.startsWith('🎙') ? 0 : '.07em' }}>{display.eyebrow}</div>
                            <time style={{ flexShrink: 0, color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>{when.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time>
                          </div>
                          {display.fileName && <div style={{ marginTop: 5, color: S.ink, fontSize: 12.5 }}>{display.fileName}</div>}
                          {display.text && <p style={{ margin: '7px 0 0', whiteSpace: 'pre-wrap', color: '#d5d4cf', fontSize: 13, lineHeight: 1.58 }}>{display.text}</p>}
                          {!display.text && display.eyebrow.startsWith('🎙') && <div style={{ marginTop: 5, color: S.muted2, fontSize: 10.5 }}>Transcript appears after the next reasoning cycle.</div>}
                          {entry.processing_status === 'failed' && <div style={{ marginTop: 6, color: S.red, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8 }}>PROCESSING INTERRUPTED</div>}
                        </article>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>

        <footer style={{ height: 36 }} />
      </div>
    </main>
  )
}
