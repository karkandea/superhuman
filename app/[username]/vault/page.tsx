'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { ingestManualKnowledge } from '@/lib/player-knowledge-service'
import { KNOWLEDGE_ENTRY_TYPES, type ManualKnowledgeEntryType } from '@/lib/player-knowledge'

interface VaultEntry {
  id: string
  entry_type: string
  raw_text: string
  processing_status: string
  materiality_status: string
  materiality_disposition?: 'no_change' | 'suggest' | 'auto_interrupt'
  interrupt_status?: 'suggested' | 'applied'
  occurred_at: string | null
  created_at: string
}

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', input: '#0f1319',
  line: '#232a35', lineStrong: '#303946', ink: '#ECEAE3', muted: '#7e8795',
  muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

const TYPE_LABEL: Record<ManualKnowledgeEntryType, string> = {
  life_update: 'Life update', note: 'Note', journal: 'Journal / curhat', goal: 'Goal / ambition',
  relationship: 'Relationship context', career: 'Career / work', wellness: 'Wellness',
}

const TYPE_SHORT_LABEL: Record<string, string> = {
  life_update: 'LIFE UPDATE', note: 'NOTE', journal: 'JOURNAL', goal: 'GOAL',
  relationship: 'RELATIONSHIP', career: 'CAREER', wellness: 'WELLNESS',
}

function statusLabel(entry: VaultEntry) {
  if (entry.processing_status === 'pending' || entry.processing_status === 'processing') return { label: 'SYSTEM PROCESSING', color: S.gold }
  if (entry.processing_status === 'failed') return { label: 'NEEDS ATTENTION', color: S.red }
  if (entry.processing_status !== 'processed') return { label: entry.processing_status.toUpperCase(), color: S.muted }

  if (entry.materiality_status === 'pending') return { label: 'CHECKING TODAY', color: S.gold }
  if (entry.materiality_disposition === 'no_change') return { label: 'UPDATED · QUESTS UNCHANGED', color: S.amber }
  if (entry.materiality_disposition === 'suggest') return { label: 'ADJUSTMENT SUGGESTED', color: S.gold }
  if (entry.materiality_disposition === 'auto_interrupt' && entry.interrupt_status === 'applied') return { label: 'SYSTEM INTERRUPT', color: S.amber }
  if (entry.materiality_disposition === 'auto_interrupt') return { label: 'ADJUSTING TODAY', color: S.gold }
  return { label: 'UNDERSTOOD', color: S.amber }
}

function isFoundationUnavailable(message: string) {
  const value = message.toLowerCase()
  return value.includes('ingest_manual_knowledge') || value.includes('knowledge_entries') || value.includes('schema cache')
}

export default function LifeVaultPage() {
  const router = useRouter()
  const params = useParams<{ username: string }>()
  const username = decodeURIComponent(params.username)

  const [playerId, setPlayerId] = useState<string | null>(null)
  const [entryType, setEntryType] = useState<ManualKnowledgeEntryType>('life_update')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [foundationReady, setFoundationReady] = useState(true)

  const loadEntries = useCallback(async (id: string) => {
    const { data, error } = await supabase
      .from('knowledge_entries')
      .select('id,entry_type,raw_text,processing_status,materiality_status,occurred_at,created_at')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(25)

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
    const assessmentByKnowledge = new Map<string, { id: string; disposition: VaultEntry['materiality_disposition'] }>()
    let interruptByAssessment = new Map<string, VaultEntry['interrupt_status']>()

    if (knowledgeIds.length > 0) {
      const { data: assessments, error: assessmentError } = await supabase
        .from('materiality_assessments')
        .select('id,knowledge_entry_id,disposition,created_at')
        .eq('user_id', id)
        .in('knowledge_entry_id', knowledgeIds)
        .order('created_at', { ascending: false })
      if (assessmentError) throw assessmentError

      for (const assessment of assessments ?? []) {
        if (!assessmentByKnowledge.has(assessment.knowledge_entry_id)) {
          assessmentByKnowledge.set(assessment.knowledge_entry_id, { id: assessment.id, disposition: assessment.disposition })
        }
      }

      const assessmentIds = [...assessmentByKnowledge.values()].map((assessment) => assessment.id)
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
    const timer = window.setInterval(() => { void loadEntries(playerId).catch(() => {}) }, 4000)
    return () => window.clearInterval(timer)
  }, [loadEntries, playerId])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!playerId || !foundationReady || saving) return

    setSaving(true)
    setMessage('')
    try {
      await ingestManualKnowledge(
        { rpc: (name, values) => supabase.rpc(name, values) },
        {
          entryType, text, title: title || undefined, occurredAt: new Date().toISOString(),
          metadata: { ingestion: 'manual_vault_ui' },
        },
      )
      setText('')
      setTitle('')
      setMessage('Saved. System processing has started — you can leave this page.')
      await loadEntries(playerId)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to save knowledge'
      if (isFoundationUnavailable(errorMessage)) setFoundationReady(false)
      setMessage(errorMessage)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <main style={{ minHeight: '100dvh', background: S.bg, color: S.muted, display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, letterSpacing: '.12em' }}>LOADING LIFE VAULT...</main>
  }

  return (
    <main style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 720, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '30px 0 22px', borderBottom: `1px solid ${S.line}` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 10, fontWeight: 700, letterSpacing: '.18em' }}>PLAYER KNOWLEDGE</div>
              <h1 style={{ margin: '9px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(30px,8vw,42px)', lineHeight: 1, letterSpacing: '-.04em' }}>Life Vault</h1>
              <p style={{ margin: '12px 0 0', maxWidth: 570, color: S.muted, fontSize: 13, lineHeight: 1.6 }}>
                Tell the System what is happening in your life. Goals, obstacles, decisions, wins, worries — anything that should influence what you do next.
              </p>
            </div>
            <Link href={`/${encodeURIComponent(username)}`} style={{ flexShrink: 0, color: S.gold, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, letterSpacing: '.08em', paddingTop: 2 }}>DAILY QUEST →</Link>
          </div>
        </header>

        {!foundationReady && (
          <section style={{ marginTop: 18, border: '1px solid #4a3a21', background: '#17140f', borderRadius: 14, padding: 14 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontSize: 9, letterSpacing: '.12em' }}>SYSTEM PAUSED</div>
            <div style={{ marginTop: 6, color: '#d7bd8c', fontSize: 12, lineHeight: 1.55 }}>Life Vault is temporarily unavailable. Your existing knowledge is safe; try again when the System reconnects.</div>
          </section>
        )}

        <section style={{ marginTop: 22 }}>
          <div style={{ marginBottom: 9, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: S.muted, letterSpacing: '.14em' }}>ADD PLAYER CONTEXT</div>
          <form onSubmit={submit} style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, padding: '18px 16px', boxShadow: '0 16px 50px rgba(0,0,0,.16)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
              <label style={{ display: 'block' }}>
                <span style={{ display: 'block', marginBottom: 7, color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, letterSpacing: '.08em' }}>CONTEXT TYPE</span>
                <select value={entryType} onChange={(event) => setEntryType(event.target.value as ManualKnowledgeEntryType)} disabled={!foundationReady || saving} style={{ width: '100%', height: 44, borderRadius: 11, border: `1px solid ${S.lineStrong}`, background: S.input, color: S.ink, padding: '0 12px', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 13, outline: 'none' }}>
                  {KNOWLEDGE_ENTRY_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABEL[type]}</option>)}
                </select>
              </label>
              <label style={{ display: 'block' }}>
                <span style={{ display: 'block', marginBottom: 7, color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, letterSpacing: '.08em' }}>TITLE · OPTIONAL</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} disabled={!foundationReady || saving} placeholder="e.g. Interview result" style={{ boxSizing: 'border-box', width: '100%', height: 44, borderRadius: 11, border: `1px solid ${S.lineStrong}`, background: S.input, color: S.ink, padding: '0 12px', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 13, outline: 'none' }} />
              </label>
            </div>

            <label style={{ display: 'block', marginTop: 14 }}>
              <span style={{ display: 'block', marginBottom: 7, color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, letterSpacing: '.08em' }}>WHAT SHOULD THE SYSTEM KNOW?</span>
              <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={50000} rows={7} disabled={!foundationReady || saving} placeholder="Ceritain apa yang lagi terjadi, apa yang lo kejar, hambatan yang muncul, atau keputusan yang lagi lo pikirin..." style={{ boxSizing: 'border-box', width: '100%', minHeight: 160, resize: 'vertical', borderRadius: 13, border: `1px solid ${S.lineStrong}`, background: S.input, color: S.ink, padding: '13px 14px', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 14, lineHeight: 1.6, outline: 'none' }} />
            </label>

            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ color: S.muted2, fontSize: 11, lineHeight: 1.5, maxWidth: 430 }}>Save once. System will understand the update, then decide whether it changes today or only future progression.</div>
              <button type="submit" disabled={!foundationReady || saving || !text.trim()} style={{ minWidth: 138, height: 42, border: 'none', borderRadius: 10, padding: '0 16px', background: !foundationReady || saving || !text.trim() ? '#3a3328' : S.amber, color: !foundationReady || saving || !text.trim() ? S.muted : S.bg, fontFamily: '"IBM Plex Mono", monospace', fontWeight: 700, fontSize: 10, letterSpacing: '.08em', cursor: !foundationReady || saving || !text.trim() ? 'default' : 'pointer' }}>
                {saving ? 'SAVING...' : 'SAVE TO VAULT'}
              </button>
            </div>
          </form>

          {message && (
            <div style={{ marginTop: 10, background: S.panel2, border: `1px solid ${S.line}`, borderRadius: 12, padding: '11px 13px', color: message.startsWith('Saved.') ? S.gold : S.red, fontSize: 11.5, lineHeight: 1.5 }}>{message}</div>
          )}
        </section>

        <section style={{ marginTop: 30 }}>
          <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 14, marginBottom: 10 }}>
            <div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9, letterSpacing: '.14em' }}>MEMORY FEED</div>
              <h2 style={{ margin: '5px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 20, letterSpacing: '-.02em' }}>Recent knowledge</h2>
            </div>
            <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>LATEST 25 · LIVE</div>
          </div>

          {entries.length === 0 ? (
            <div style={{ border: `1px dashed ${S.lineStrong}`, borderRadius: 16, background: S.panel2, padding: '24px 18px', textAlign: 'center' }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, color: S.gold, letterSpacing: '.1em' }}>NO KNOWLEDGE YET</div>
              <div style={{ marginTop: 8, color: S.muted, fontSize: 12.5, lineHeight: 1.55 }}>Your first update gives the System something real to understand before it assigns quests.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {entries.map((entry) => {
                const processing = statusLabel(entry)
                return (
                  <article key={entry.id} style={{ background: S.panel2, border: `1px solid ${S.line}`, borderRadius: 15, padding: '15px 15px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: S.gold, letterSpacing: '.1em' }}>{TYPE_SHORT_LABEL[entry.entry_type] ?? entry.entry_type.toUpperCase()}</span>
                        <span style={{ width: 3, height: 3, borderRadius: 99, background: S.lineStrong }} />
                        <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: processing.color, letterSpacing: '.08em' }}>{processing.label}</span>
                      </div>
                      <time style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>
                        {new Date(entry.occurred_at ?? entry.created_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </time>
                    </div>
                    <p style={{ margin: '10px 0 0', whiteSpace: 'pre-wrap', color: '#d8d7d2', fontSize: 13.5, lineHeight: 1.6 }}>{entry.raw_text}</p>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <footer style={{ padding: '34px 0 8px', textAlign: 'center' }}>
          <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, lineHeight: 1.6 }}>
            LIFE VAULT FEEDS SYSTEM UNDERSTANDING<br />
            STABLE BY DEFAULT · INTERRUPT ONLY WHEN TODAY MATERIALLY CHANGES
          </div>
        </footer>
      </div>
    </main>
  )
}
