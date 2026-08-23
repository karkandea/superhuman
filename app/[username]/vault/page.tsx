'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

interface VaultEntry {
  id: string
  raw_text: string
  content_metadata: Record<string, unknown>
  processing_status: string
  occurred_at: string | null
  created_at: string
}

interface UnderstandingSourceRow {
  knowledge_entry_id: string
  understanding_id: string
}

interface UnderstandingRow {
  id: string
  summary: string
  status: string
  importance: number | null
}

type VaultFeedItem =
  | { kind: 'initialization'; id: string; entries: VaultEntry[]; timestamp: string }
  | { kind: 'entry'; id: string; entry: VaultEntry; timestamp: string }

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

const INITIALIZATION_LABELS: Record<string, string> = {
  life_context: 'Current situation',
  schedule_structure: 'Weekly capacity',
  current_direction: 'Current focus',
  desired_outcome: 'Desired outcome',
  major_constraint: 'Biggest blocker',
}

const INITIALIZATION_PROMPTS: Record<string, string> = {
  life_context: 'Sekarang keseharian lo lagi kayak gimana?',
  schedule_structure: 'Biasanya seminggu lo kayak gimana? Kapan paling sibuk, dan kapan biasanya agak kosong?',
  current_direction: 'Beberapa minggu ke depan, apa yang paling pengen lo fokusin?',
  desired_outcome: 'Kalau itu berjalan sesuai yang lo mau, hasil yang pengen lo lihat tuh kayak gimana?',
  major_constraint: 'Sekarang yang paling bikin susah buat sampai ke sana apa?',
}

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

function metadataString(entry: VaultEntry, key: string) {
  return asString((entry.content_metadata ?? {})[key])
}

function metadataNumber(entry: VaultEntry, key: string) {
  return asNumber((entry.content_metadata ?? {})[key])
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

function normalizeStoredText(value: string) {
  return value.replace(/\\n/g, '\n').trim()
}

function splitInitializationText(entry: VaultEntry) {
  const normalized = normalizeStoredText(entry.raw_text)
  const questionMarker = 'Initialization question:'
  const transcriptMarker = 'Player voice transcript:'
  const questionStart = normalized.indexOf(questionMarker)
  const transcriptStart = normalized.indexOf(transcriptMarker)
  const questionKey = metadataString(entry, 'questionKey') ?? ''

  if (questionStart >= 0 && transcriptStart > questionStart) {
    return {
      question: normalized.slice(questionStart + questionMarker.length, transcriptStart).trim(),
      answer: normalized.slice(transcriptStart + transcriptMarker.length).trim(),
    }
  }

  return {
    question: INITIALIZATION_PROMPTS[questionKey] ?? 'Follow-up question',
    answer: normalized,
  }
}

function isInitializationEntry(entry: VaultEntry) {
  const metadata = entry.content_metadata ?? {}
  return metadata.system === 'player_initialization' && ['basic', 'adaptive'].includes(String(metadata.origin ?? ''))
}

function cleanEntryText(entry: VaultEntry) {
  const normalized = normalizeStoredText(entry.raw_text)
  if (isInitializationEntry(entry)) return splitInitializationText(entry).answer
  if (/^\[Voice update attached\./i.test(normalized)) return ''
  return normalized
}

function preview(value: string, max = 210) {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return { text: compact, truncated: false }
  const cut = compact.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return { text: `${cut.slice(0, Math.max(80, lastSpace))}…`, truncated: true }
}

function naturalList(items: string[]) {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

function initializationSummary(entries: VaultEntry[]) {
  const labels = Object.keys(INITIALIZATION_LABELS)
    .filter(key => entries.some(entry => metadataString(entry, 'questionKey') === key))
    .map(key => INITIALIZATION_LABELS[key].toLowerCase())
  const adaptiveCount = entries.filter(entry => metadataString(entry, 'origin') === 'adaptive').length
  const base = labels.length > 0
    ? `You gave the System its starting picture: ${naturalList(labels)}.`
    : 'You gave the System the starting context it needed to understand your life.'
  return adaptiveCount > 0 ? `${base} ${adaptiveCount} follow-up ${adaptiveCount === 1 ? 'answer was' : 'answers were'} added during calibration.` : base
}

function entryDisplay(entry: VaultEntry) {
  const metadata = entry.content_metadata ?? {}
  const input = asString(metadata.input)
  const answerMode = asString(metadata.answerMode)
  const voice = input === 'voice' || answerMode === 'audio'
  const duration = formatDuration(asNumber(metadata.durationMs))
  const transcriptReady = asString(metadata.transcriptStatus) === 'ready' || Boolean(metadata.voiceTranscriptAvailable) || (voice && !entry.raw_text.includes('transcript is pending'))
  const fileName = asString(metadata.fileName)
  const extension = asString(metadata.fileExtension)
  const text = cleanEntryText(entry)

  if (voice) {
    return {
      title: `Voice update${duration ? ` · ${duration}` : ''}`,
      text: transcriptReady ? text : '',
      voice: true,
      fileName: null,
    }
  }
  if (fileName) {
    return {
      title: extension ? `${extension.toUpperCase()} update` : 'File update',
      text,
      voice: false,
      fileName,
    }
  }
  return { title: 'Life update', text, voice: false, fileName: null }
}

function detailCountLabel(count: number) {
  if (count <= 0) return null
  return `${count} ${count === 1 ? 'detail' : 'details'} saved`
}

function statusCopy(entry: VaultEntry, detailCount: number) {
  if (entry.processing_status === 'failed') return { text: 'Saved · processing paused', color: S.red }
  if (entry.processing_status === 'pending') return { text: 'Saved · waiting for the next System decision', color: S.muted }
  const linked = detailCountLabel(detailCount)
  return { text: linked ?? 'Saved to Life Vault', color: linked ? S.gold : S.muted }
}

export default function LifeVaultPage() {
  const router = useRouter()
  const params = useParams<{ username: string }>()
  const username = decodeURIComponent(params.username)

  const [playerId, setPlayerId] = useState<string | null>(null)
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [detailIdsByEntry, setDetailIdsByEntry] = useState<Record<string, string[]>>({})
  const [detailSummariesByEntry, setDetailSummariesByEntry] = useState<Record<string, string[]>>({})
  const [understandingUpdatedAt, setUnderstandingUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [foundationReady, setFoundationReady] = useState(true)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [showHowItWorks, setShowHowItWorks] = useState(false)
  const [showInitializationAnswers, setShowInitializationAnswers] = useState(false)
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<string>>(() => new Set())

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
        setDetailIdsByEntry({})
        setDetailSummariesByEntry({})
        return
      }
      throw knowledgeResult.error
    }
    if (briefResult.error) throw briefResult.error

    const rows = (knowledgeResult.data ?? []) as VaultEntry[]
    const ids = rows.map(entry => entry.id)
    const nextDetailIds: Record<string, string[]> = {}
    const nextDetailSummaries: Record<string, string[]> = {}

    if (ids.length > 0) {
      const sourceResult = await supabase
        .from('understanding_sources')
        .select('knowledge_entry_id,understanding_id')
        .eq('user_id', id)
        .in('knowledge_entry_id', ids)

      if (!sourceResult.error) {
        const sourceRows = (sourceResult.data ?? []) as UnderstandingSourceRow[]
        for (const row of sourceRows) {
          const current = nextDetailIds[row.knowledge_entry_id] ?? []
          if (!current.includes(row.understanding_id)) current.push(row.understanding_id)
          nextDetailIds[row.knowledge_entry_id] = current
        }

        const understandingIds = [...new Set(sourceRows.map(row => row.understanding_id))]
        if (understandingIds.length > 0) {
          const understandingResult = await supabase
            .from('derived_understanding')
            .select('id,summary,status,importance')
            .eq('user_id', id)
            .in('id', understandingIds)

          if (!understandingResult.error) {
            const understandingRows = ((understandingResult.data ?? []) as UnderstandingRow[])
              .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || Number(right.importance ?? 0) - Number(left.importance ?? 0))
            const summaryById = new Map(understandingRows.map(row => [row.id, row.summary]))
            for (const source of sourceRows) {
              const summary = summaryById.get(source.understanding_id)?.trim()
              if (!summary) continue
              const current = nextDetailSummaries[source.knowledge_entry_id] ?? []
              if (!current.includes(summary)) current.push(summary)
              nextDetailSummaries[source.knowledge_entry_id] = current
            }
          }
        }
      }
    }

    setFoundationReady(true)
    setEntries(rows)
    setDetailIdsByEntry(nextDetailIds)
    setDetailSummariesByEntry(nextDetailSummaries)
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

  const feedItems = useMemo<VaultFeedItem[]>(() => {
    const initializationEntries = entries.filter(isInitializationEntry)
    const regularEntries = entries.filter(entry => !isInitializationEntry(entry))
    const items: VaultFeedItem[] = regularEntries.map(entry => ({
      kind: 'entry',
      id: entry.id,
      entry,
      timestamp: entry.occurred_at ?? entry.created_at,
    }))

    if (initializationEntries.length > 0) {
      const timestamp = initializationEntries
        .map(entry => entry.occurred_at ?? entry.created_at)
        .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0]
      items.push({ kind: 'initialization', id: 'initialization-interview', entries: initializationEntries, timestamp })
    }

    return items.sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
  }, [entries])

  const groups = useMemo(() => {
    const map = new Map<string, VaultFeedItem[]>()
    for (const item of feedItems) {
      const key = dateKey(item.timestamp)
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [feedItems])

  const hasFailedEntry = entries.some(entry => entry.processing_status === 'failed')
  const progressionHref = `/${encodeURIComponent(username)}/history`

  function detailCountForEntries(groupEntries: VaultEntry[]) {
    const ids = new Set<string>()
    for (const entry of groupEntries) {
      for (const detailId of detailIdsByEntry[entry.id] ?? []) ids.add(detailId)
    }
    return ids.size
  }

  function toggleEntry(id: string) {
    setExpandedEntryIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function checkProcessingStatus() {
    if (!playerId || checkingStatus) return
    setCheckingStatus(true)
    setMessage('')
    try {
      await loadEntries(playerId)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Couldn’t refresh Vault status.')
    } finally {
      setCheckingStatus(false)
    }
  }

  if (loading) {
    return <main style={{ minHeight: '100dvh', background: S.bg, color: S.muted, display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, letterSpacing: '.1em' }}>LOADING VAULT…</main>
  }

  return (
    <main style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif' }}>
      <div style={{ width: '100%', maxWidth: 680, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '30px 0 20px' }}>
          <h1 style={{ margin: 0, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(34px,9vw,46px)', lineHeight: 1, letterSpacing: '-.045em' }}>Life Vault</h1>
          <p style={{ margin: '9px 0 0', maxWidth: 560, color: S.muted, fontSize: 13, lineHeight: 1.58 }}>
            Your private memory for the System. What you share here helps it understand your life and choose what matters next.
          </p>

          <div style={{ marginTop: 18, padding: '12px 0', borderTop: `1px solid ${S.line}`, borderBottom: `1px solid ${S.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8, letterSpacing: '.12em' }}>SYSTEM MEMORY</div>
              <div style={{ marginTop: 4, color: '#d7d6d1', fontSize: 11.5 }}>
                {understandingUpdatedAt
                  ? `Updated ${new Date(understandingUpdatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`
                  : 'Building from what you’ve shared'}
              </div>
            </div>
            <Link href={progressionHref} style={{ flexShrink: 0, color: S.gold, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700 }}>
              SEE UNDERSTANDING →
            </Link>
          </div>

          <button
            type="button"
            aria-expanded={showHowItWorks}
            onClick={() => setShowHowItWorks(value => !value)}
            style={{ marginTop: 11, border: 0, background: 'transparent', padding: 0, color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: 'pointer' }}
          >
            {showHowItWorks ? 'HIDE HOW LIFE VAULT WORKS ↑' : 'HOW LIFE VAULT WORKS →'}
          </button>

          {showHowItWorks && (
            <div style={{ marginTop: 12, padding: '10px 0 2px 12px', borderLeft: `2px solid ${S.lineStrong}`, color: S.muted, fontSize: 11.5, lineHeight: 1.58 }}>
              Share goals, plans, constraints, wins, setbacks, or anything that changed. Your update stays in the Vault and is considered when the System next needs to decide what matters.
            </div>
          )}
        </header>

        {!foundationReady && (
          <div style={{ border: '1px solid #4a3a21', background: '#17140f', borderRadius: 13, padding: '12px 13px', color: '#d7bd8c', fontSize: 11.5, lineHeight: 1.5 }}>
            Life Vault belum bisa reconnect. Existing memory tetap aman.
          </div>
        )}

        {message && <div role="status" style={{ marginBottom: 13, color: S.red, fontSize: 11.5, lineHeight: 1.5 }}>{message}</div>}

        {hasFailedEntry && (
          <div style={{ marginBottom: 20, padding: '11px 0', borderTop: `1px solid ${S.line}`, borderBottom: `1px solid ${S.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ color: S.ink, fontSize: 11.5 }}>One update is saved, but the System hasn’t finished processing it.</div>
              <div style={{ marginTop: 3, color: S.muted2, fontSize: 10.5 }}>Nothing needs to be entered again.</div>
            </div>
            <button type="button" onClick={() => { void checkProcessingStatus() }} disabled={checkingStatus} style={{ flexShrink: 0, border: 0, background: 'transparent', color: S.gold, padding: 4, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: checkingStatus ? 'default' : 'pointer' }}>
              {checkingStatus ? 'CHECKING…' : 'CHECK STATUS'}
            </button>
          </div>
        )}

        <section aria-label="What belongs in Life Vault" style={{ marginBottom: 26 }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8, letterSpacing: '.12em' }}>WHAT TO SHARE</div>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {['A goal changed', 'Something happened', 'I’m stuck on something', 'About my life'].map(prompt => (
              <span key={prompt} style={{ border: `1px solid ${S.line}`, borderRadius: 999, padding: '6px 9px', color: S.muted, background: S.panel2, fontSize: 10.5 }}>{prompt}</span>
            ))}
          </div>
        </section>

        <section>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.13em' }}>RECENT UPDATES</div>
            {entries.length > 0 && <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 7.8 }}>NEWEST FIRST</div>}
          </div>

          {entries.length === 0 ? (
            <div style={{ padding: '28px 0', borderTop: `1px solid ${S.line}`, color: S.muted, fontSize: 12.5, lineHeight: 1.55 }}>
              Tell the System something. Your first update will appear here.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 30 }}>
              {groups.map(([key, items]) => (
                <section key={key}>
                  <h2 style={{ margin: '0 0 9px', fontFamily: '"Space Grotesk", sans-serif', fontSize: 17, color: S.ink, fontWeight: 650 }}>{groupLabel(key)}</h2>
                  <div style={{ borderTop: `1px solid ${S.line}` }}>
                    {items.map(item => {
                      if (item.kind === 'initialization') {
                        const sortedEntries = [...item.entries].sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime())
                        const totalDuration = formatDuration(sortedEntries.reduce((sum, entry) => sum + (metadataNumber(entry, 'durationMs') ?? 0), 0))
                        const detailCount = detailCountForEntries(sortedEntries)
                        return (
                          <article key={item.id} style={{ padding: '16px 1px 17px', borderBottom: `1px solid ${S.line}` }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontSize: 8.5, letterSpacing: '.11em' }}>INITIALIZATION INTERVIEW</div>
                              <time style={{ flexShrink: 0, color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8 }}>{new Date(item.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time>
                            </div>
                            <div style={{ marginTop: 7, fontFamily: '"Space Grotesk", sans-serif', color: S.ink, fontSize: 16, fontWeight: 650 }}>Your starting picture</div>
                            <div style={{ marginTop: 4, color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>
                              {sortedEntries.length} answers{totalDuration ? ` · ${totalDuration}` : ''}
                            </div>
                            <p style={{ margin: '9px 0 0', color: '#d1d0cb', fontSize: 12.5, lineHeight: 1.55 }}>{initializationSummary(sortedEntries)}</p>
                            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                              {detailCount > 0 && <span style={{ color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>{detailCountLabel(detailCount)}</span>}
                              <button type="button" onClick={() => setShowInitializationAnswers(value => !value)} style={{ border: 0, background: 'transparent', color: S.muted, padding: 0, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: 'pointer' }}>
                                {showInitializationAnswers ? 'HIDE ANSWERS ↑' : 'VIEW ANSWERS →'}
                              </button>
                            </div>

                            {showInitializationAnswers && (
                              <div style={{ marginTop: 13, borderTop: `1px solid ${S.line}` }}>
                                {sortedEntries.map((entry, index) => {
                                  const questionKey = metadataString(entry, 'questionKey') ?? ''
                                  const copy = splitInitializationText(entry)
                                  const duration = formatDuration(metadataNumber(entry, 'durationMs'))
                                  const open = expandedEntryIds.has(entry.id)
                                  const label = INITIALIZATION_LABELS[questionKey] ?? `Follow-up ${index + 1}`
                                  return (
                                    <div key={entry.id} style={{ padding: '11px 0', borderBottom: index === sortedEntries.length - 1 ? 'none' : `1px solid ${S.line}` }}>
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                        <div>
                                          <div style={{ color: S.ink, fontSize: 11.5, fontWeight: 600 }}>{label}</div>
                                          {duration && <div style={{ marginTop: 2, color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8 }}>{duration}</div>}
                                        </div>
                                        <button type="button" onClick={() => toggleEntry(entry.id)} style={{ flexShrink: 0, border: 0, background: 'transparent', color: S.muted, padding: 3, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, cursor: 'pointer' }}>
                                          {open ? 'HIDE' : 'VIEW ANSWER'}
                                        </button>
                                      </div>
                                      {open && (
                                        <div style={{ marginTop: 10, padding: '10px 11px', background: S.panel2, borderLeft: `2px solid ${S.lineStrong}` }}>
                                          <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 7.8, letterSpacing: '.1em' }}>QUESTION</div>
                                          <div style={{ marginTop: 4, color: S.muted, fontSize: 11, lineHeight: 1.5 }}>{copy.question}</div>
                                          <div style={{ marginTop: 10, fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 7.8, letterSpacing: '.1em' }}>YOUR ANSWER</div>
                                          <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', color: '#d4d3ce', fontSize: 12, lineHeight: 1.58 }}>{copy.answer}</div>
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </article>
                        )
                      }

                      const entry = item.entry
                      const display = entryDisplay(entry)
                      const detailCount = (detailIdsByEntry[entry.id] ?? []).length
                      const linkedSummary = detailSummariesByEntry[entry.id]?.[0]?.trim() ?? ''
                      const fallbackPreview = preview(display.text)
                      const summary = linkedSummary || fallbackPreview.text
                      const when = new Date(item.timestamp)
                      const expanded = expandedEntryIds.has(entry.id)
                      const status = statusCopy(entry, detailCount)
                      const hasExpandableText = Boolean(display.text)

                      return (
                        <article key={entry.id} style={{ padding: '15px 1px 16px', borderBottom: `1px solid ${S.line}` }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ minWidth: 0, color: display.voice ? S.gold : S.ink, fontSize: display.voice ? 12 : 11.5, fontWeight: 600 }}>{display.voice ? `🎙 ${display.title}` : display.title}</div>
                            <time style={{ flexShrink: 0, color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8 }}>{when.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time>
                          </div>
                          {display.fileName && <div style={{ marginTop: 5, color: S.muted, fontSize: 10.5 }}>{display.fileName}</div>}

                          <p style={{ margin: '8px 0 0', color: summary ? '#d1d0cb' : S.muted2, fontSize: 12.5, lineHeight: 1.55 }}>
                            {summary || (display.voice ? 'Voice update saved. The System will use the audio at the next reasoning moment.' : 'Saved to your Life Vault.')}
                          </p>

                          <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                            <span style={{ color: status.color, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.2 }}>{status.text}</span>
                            {hasExpandableText && (
                              <button type="button" onClick={() => toggleEntry(entry.id)} style={{ border: 0, background: 'transparent', color: S.muted, padding: 0, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.2, fontWeight: 700, cursor: 'pointer' }}>
                                {expanded ? 'HIDE ↑' : display.voice ? 'VIEW TRANSCRIPT →' : 'VIEW UPDATE →'}
                              </button>
                            )}
                          </div>

                          {expanded && hasExpandableText && (
                            <div style={{ marginTop: 11, padding: '10px 11px', background: S.panel2, borderLeft: `2px solid ${S.lineStrong}` }}>
                              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 7.8, letterSpacing: '.1em' }}>{display.voice ? 'TRANSCRIPT' : 'FULL UPDATE'}</div>
                              <div style={{ marginTop: 5, whiteSpace: 'pre-wrap', color: '#d4d3ce', fontSize: 12, lineHeight: 1.58 }}>{display.text}</div>
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>

        <footer style={{ height: 38 }} />
      </div>
    </main>
  )
}
