'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import SystemFreshnessCard from '../system-freshness-card'
import UpdateSystemComposer from '../update-system-composer'
import { supabase } from '@/lib/supabase'
import { todayStr } from '@/lib/checklist-data'

interface VaultEntry {
  id: string
  source_id: string
  raw_text: string
  content_metadata: Record<string, unknown>
  processing_status: string
  materiality_status: string
  materiality_disposition?: 'no_change' | 'suggest' | 'auto_interrupt'
  interrupt_status?: 'suggested' | 'applied'
  occurred_at: string | null
  created_at: string
}

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

function statusLabel(entry: VaultEntry) {
  if (entry.processing_status === 'pending') return { label: 'COLLECTING UPDATES', color: S.gold }
  if (entry.processing_status === 'processing') return { label: 'PROCESSING', color: S.gold }
  if (entry.processing_status === 'failed') return { label: 'PROCESSING INTERRUPTED', color: S.red }
  if (entry.processing_status !== 'processed') return { label: entry.processing_status.toUpperCase(), color: S.muted }

  if (entry.materiality_status === 'pending') return { label: 'CHECKING TODAY', color: S.gold }
  if (entry.materiality_disposition === 'no_change') return { label: 'UPDATED · QUESTS UNCHANGED', color: S.amber }
  if (entry.materiality_disposition === 'suggest') return { label: 'SYSTEM SUGGESTION', color: S.gold }
  if (entry.materiality_disposition === 'auto_interrupt' && entry.interrupt_status === 'applied') return { label: 'SYSTEM INTERRUPT', color: S.amber }
  if (entry.materiality_disposition === 'auto_interrupt') return { label: 'ADJUSTING TODAY', color: S.gold }
  return { label: 'UPDATED', color: S.amber }
}

function isFoundationUnavailable(message: string) {
  const value = message.toLowerCase()
  return value.includes('ingest_manual_knowledge') || value.includes('knowledge_entries') || value.includes('schema cache')
}

function fileMetadata(entry: VaultEntry) {
  const fileName = typeof entry.content_metadata?.fileName === 'string' ? entry.content_metadata.fileName : null
  const fileExtension = typeof entry.content_metadata?.fileExtension === 'string' ? entry.content_metadata.fileExtension : null
  const fileSizeBytes = typeof entry.content_metadata?.fileSizeBytes === 'number' ? entry.content_metadata.fileSizeBytes : null
  return fileName ? { fileName, fileExtension, fileSizeBytes } : null
}

function formatFileSize(bytes: number | null) {
  if (!bytes) return null
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export default function LifeVaultPage() {
  const router = useRouter()
  const params = useParams<{ username: string }>()
  const username = decodeURIComponent(params.username)

  const [playerId, setPlayerId] = useState<string | null>(null)
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [foundationReady, setFoundationReady] = useState(true)
  const [freshnessToken, setFreshnessToken] = useState(0)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const loadEntries = useCallback(async (id: string) => {
    const { data, error } = await supabase
      .from('knowledge_entries')
      .select('id,source_id,raw_text,content_metadata,processing_status,materiality_status,occurred_at,created_at')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(40)

    if (error) {
      if (isFoundationUnavailable(error.message)) {
        setFoundationReady(false)
        setEntries([])
        return
      }
      throw error
    }

    const rows = (data ?? []) as VaultEntry[]
    const knowledgeIds = rows.map((entry) => entry.id)
    const visibleKnowledgeIds = new Set(knowledgeIds)
    const assessmentByKnowledge = new Map<string, { id: string; disposition: VaultEntry['materiality_disposition'] }>()
    let interruptByAssessment = new Map<string, VaultEntry['interrupt_status']>()

    if (knowledgeIds.length > 0) {
      const { data: assessments, error: assessmentError } = await supabase
        .from('materiality_assessments')
        .select('id,knowledge_entry_id,knowledge_entry_ids,disposition,created_at')
        .eq('user_id', id)
        .overlaps('knowledge_entry_ids', knowledgeIds)
        .order('created_at', { ascending: false })
      if (assessmentError) throw assessmentError

      for (const assessment of assessments ?? []) {
        const members = Array.isArray(assessment.knowledge_entry_ids) && assessment.knowledge_entry_ids.length > 0
          ? assessment.knowledge_entry_ids
          : [assessment.knowledge_entry_id]
        for (const knowledgeId of members) {
          if (visibleKnowledgeIds.has(knowledgeId) && !assessmentByKnowledge.has(knowledgeId)) {
            assessmentByKnowledge.set(knowledgeId, { id: assessment.id, disposition: assessment.disposition })
          }
        }
      }

      const assessmentIds = [...new Set([...assessmentByKnowledge.values()].map((assessment) => assessment.id))]
      if (assessmentIds.length > 0) {
        const { data: interrupts, error: interruptError } = await supabase
          .from('quest_interrupts')
          .select('assessment_id,status')
          .eq('user_id', id)
          .in('assessment_id', assessmentIds)
        if (interruptError) throw interruptError
        interruptByAssessment = new Map((interrupts ?? []).map((interrupt) => [interrupt.assessment_id, interrupt.status as VaultEntry['interrupt_status']]))
      }
    }

    setFoundationReady(true)
    setEntries(rows.map((entry) => {
      const assessment = assessmentByKnowledge.get(entry.id)
      return {
        ...entry,
        ...(assessment?.disposition ? { materiality_disposition: assessment.disposition } : {}),
        ...(assessment ? { interrupt_status: interruptByAssessment.get(assessment.id) } : {}),
      }
    }))
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
    const timer = window.setInterval(() => { void loadEntries(playerId).catch(() => {}) }, 5000)
    return () => window.clearInterval(timer)
  }, [loadEntries, playerId])

  async function handleSaved() {
    setFreshnessToken(token => token + 1)
    if (playerId) await loadEntries(playerId)
  }

  function toggleExpanded(id: string) {
    setExpandedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (loading) {
    return <main style={{ minHeight: '100dvh', background: S.bg, color: S.muted, display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, letterSpacing: '.12em' }}>LOADING LIFE VAULT…</main>
  }

  return (
    <main style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 720, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '27px 0 20px', borderBottom: `1px solid ${S.line}` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9.5, fontWeight: 700, letterSpacing: '.18em' }}>PLAYER KNOWLEDGE</div>
              <h1 style={{ margin: '8px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(31px,8vw,43px)', lineHeight: 1, letterSpacing: '-.04em' }}>Life Vault</h1>
              <p style={{ margin: '10px 0 0', maxWidth: 560, color: S.muted, fontSize: 12.5, lineHeight: 1.6 }}>
                One place for everything you have told the System — quick updates, pasted text, journals, and text files. No folders or life categories required.
              </p>
            </div>
            <Link href={`/${encodeURIComponent(username)}`} style={{ flexShrink: 0, color: S.gold, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, letterSpacing: '.08em', paddingTop: 2 }}>TODAY →</Link>
          </div>
        </header>

        {!foundationReady && (
          <section style={{ marginTop: 17, border: '1px solid #4a3a21', background: '#17140f', borderRadius: 14, padding: 14 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontSize: 8.5, letterSpacing: '.12em' }}>SYSTEM TEMPORARILY PAUSED</div>
            <div style={{ marginTop: 6, color: '#d7bd8c', fontSize: 11.5, lineHeight: 1.55 }}>Life Vault could not reconnect. Existing knowledge is safe; do not re-enter it.</div>
          </section>
        )}

        {playerId && (
          <section style={{ marginTop: 18 }}>
            <SystemFreshnessCard playerId={playerId} date={todayStr()} refreshToken={freshnessToken} />
          </section>
        )}

        <section style={{ marginTop: 21 }}>
          <UpdateSystemComposer variant="full" onSaved={handleSaved} />
        </section>

        {message && (
          <div role="status" style={{ marginTop: 10, border: `1px solid ${S.line}`, borderRadius: 12, background: S.panel2, padding: '10px 12px', color: S.red, fontSize: 11.5, lineHeight: 1.5 }}>{message}</div>
        )}

        <section style={{ marginTop: 30 }}>
          <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 14, marginBottom: 10 }}>
            <div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.14em' }}>LIFE VAULT</div>
              <h2 style={{ margin: '5px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 20, letterSpacing: '-.02em' }}>Recent knowledge</h2>
            </div>
            <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>LATEST 40</div>
          </div>

          {entries.length === 0 ? (
            <div style={{ border: `1px dashed ${S.lineStrong}`, borderRadius: 16, background: S.panel2, padding: '24px 18px', textAlign: 'center' }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, color: S.gold, letterSpacing: '.1em' }}>VAULT EMPTY</div>
              <div style={{ marginTop: 8, color: S.muted, fontSize: 12, lineHeight: 1.55 }}>Your first update will appear here immediately after it is safely saved.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 9 }}>
              {entries.map((entry) => {
                const processing = statusLabel(entry)
                const file = fileMetadata(entry)
                const expanded = expandedIds.has(entry.id)
                const long = entry.raw_text.length > 360 || entry.raw_text.split('\n').length > 7
                return (
                  <article key={entry.id} style={{ background: S.panel2, border: `1px solid ${S.line}`, borderRadius: 15, padding: '14px 14px 13px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: file ? S.gold : S.muted, letterSpacing: '.09em' }}>{file ? `FILE · ${(file.fileExtension ?? 'TXT').toUpperCase()}` : 'UPDATE'}</span>
                          <span aria-hidden="true" style={{ width: 3, height: 3, borderRadius: 99, background: S.lineStrong }} />
                          <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: processing.color, letterSpacing: '.06em' }}>{processing.label}</span>
                        </div>
                        {file && (
                          <div style={{ marginTop: 5, color: S.ink, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {file.fileName}{formatFileSize(file.fileSizeBytes) ? <span style={{ color: S.muted2 }}> · {formatFileSize(file.fileSizeBytes)}</span> : null}
                          </div>
                        )}
                      </div>
                      <time style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, flexShrink: 0 }}>
                        {new Date(entry.occurred_at ?? entry.created_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </time>
                    </div>

                    <p style={{
                      margin: '9px 0 0', whiteSpace: 'pre-wrap', color: '#d8d7d2', fontSize: 13, lineHeight: 1.58,
                      ...(expanded || !long ? {} : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 5, overflow: 'hidden' }),
                    }}>{entry.raw_text}</p>

                    {long && (
                      <button type="button" onClick={() => toggleExpanded(entry.id)} style={{ minHeight: 34, marginTop: 7, border: 'none', background: 'transparent', color: S.gold, padding: '0 2px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: 'pointer' }}>
                        {expanded ? 'SHOW LESS' : 'VIEW DETAILS'}
                      </button>
                    )}

                    {entry.processing_status === 'failed' && (
                      <div style={{ marginTop: 7, color: S.muted, fontSize: 10.5, lineHeight: 1.45 }}>Your update is safe. Retry processing from the System status above — do not upload it again.</div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <footer style={{ padding: '34px 0 8px', textAlign: 'center' }}>
          <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, lineHeight: 1.6 }}>
            ONE PLAYER · ONE LIFE VAULT<br />RAW KNOWLEDGE STAYS BOUNDED · DAILY QUEST STAYS PRIMARY
          </div>
        </footer>
      </div>
    </main>
  )
}
