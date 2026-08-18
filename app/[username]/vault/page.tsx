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
  occurred_at: string | null
  created_at: string
}

const TYPE_LABEL: Record<ManualKnowledgeEntryType, string> = {
  life_update: 'Life update',
  note: 'Note',
  journal: 'Journal / curhat',
  goal: 'Goal / ambition',
  relationship: 'Relationship context',
  career: 'Career / work',
  wellness: 'Wellness',
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
      .select('id,entry_type,raw_text,processing_status,occurred_at,created_at')
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

    setFoundationReady(true)
    setEntries((data ?? []) as VaultEntry[])
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!playerId || !foundationReady || saving) return

    setSaving(true)
    setMessage('')
    try {
      await ingestManualKnowledge(
        {
          rpc: (name, values) => supabase.rpc(name, values),
        },
        {
          entryType,
          text,
          title: title || undefined,
          occurredAt: new Date().toISOString(),
          metadata: { ingestion: 'manual_vault_ui' },
        },
      )
      setText('')
      setTitle('')
      setMessage('Saved to Player Knowledge. Processing stays separate from the raw entry.')
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
    return <main className="min-h-screen bg-[#0c0f14] text-[#ECEAE3] p-6">Loading Life Vault…</main>
  }

  return (
    <main className="min-h-screen bg-[#0c0f14] text-[#ECEAE3] p-5 sm:p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4 border-b border-[#232a35] pb-5">
          <div>
            <p className="text-xs font-semibold tracking-[0.24em] text-[#f6b24b]">PLAYER KNOWLEDGE</p>
            <h1 className="mt-2 text-2xl font-semibold">Life Vault</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[#8a94a3]">
              Raw life context lives here first. AI understanding and signals are derived separately and must keep provenance back to these entries.
            </p>
          </div>
          <Link href={`/${encodeURIComponent(username)}`} className="text-sm text-[#ffd488] hover:underline">Daily Quest</Link>
        </header>

        {!foundationReady && (
          <section className="rounded-xl border border-[#4a3a21] bg-[#17140f] p-4 text-sm leading-6 text-[#d7bd8c]">
            Life Vault code is staged, but the database foundation is intentionally not active until Auth + owner RLS passes production verification.
          </section>
        )}

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-[#232a35] bg-[#13171f] p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm">
              <span className="text-[#aab2bf]">Context type</span>
              <select value={entryType} onChange={(event) => setEntryType(event.target.value as ManualKnowledgeEntryType)} disabled={!foundationReady || saving} className="w-full rounded-lg border border-[#2c3440] bg-[#0f1319] px-3 py-2 text-[#ECEAE3] outline-none focus:border-[#f6b24b]">
                {KNOWLEDGE_ENTRY_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABEL[type]}</option>)}
              </select>
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-[#aab2bf]">Title (optional)</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} disabled={!foundationReady || saving} placeholder="e.g. Interview result" className="w-full rounded-lg border border-[#2c3440] bg-[#0f1319] px-3 py-2 text-[#ECEAE3] outline-none placeholder:text-[#596270] focus:border-[#f6b24b]" />
            </label>
          </div>

          <label className="block space-y-2 text-sm">
            <span className="text-[#aab2bf]">What happened / what should the System know?</span>
            <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={50000} rows={6} disabled={!foundationReady || saving} placeholder="Interview gue tadi gagal karena system design." className="w-full resize-y rounded-lg border border-[#2c3440] bg-[#0f1319] px-3 py-3 leading-6 text-[#ECEAE3] outline-none placeholder:text-[#596270] focus:border-[#f6b24b]" />
          </label>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[#697381]">Raw input is stored as evidence; it is not treated as an AI conclusion.</span>
            <button type="submit" disabled={!foundationReady || saving || !text.trim()} className="rounded-lg bg-[#f6b24b] px-4 py-2 text-sm font-semibold text-[#15120c] disabled:cursor-not-allowed disabled:opacity-40">
              {saving ? 'Saving…' : 'Save update'}
            </button>
          </div>
        </form>

        {message && <p className="text-sm text-[#b8c0cb]">{message}</p>}

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide">RECENT RAW KNOWLEDGE</h2>
            <span className="text-xs text-[#697381]">Latest 25</span>
          </div>
          {entries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#2c3440] p-6 text-sm text-[#697381]">No knowledge entries yet.</div>
          ) : entries.map((entry) => (
            <article key={entry.id} className="rounded-xl border border-[#232a35] bg-[#10141b] p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#7e8795]">
                <span className="text-[#ffd488]">{entry.entry_type}</span><span>•</span><span>{entry.processing_status}</span><span>•</span>
                <time>{new Date(entry.occurred_at ?? entry.created_at).toLocaleString('id-ID')}</time>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#d8d7d2]">{entry.raw_text}</p>
            </article>
          ))}
        </section>
      </div>
    </main>
  )
}
