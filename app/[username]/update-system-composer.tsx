'use client'

import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import { ingestManualKnowledge } from '@/lib/player-knowledge-service'
import { supabase } from '@/lib/supabase'
import {
  composeKnowledgeText,
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_TEXT_LENGTH,
  validateKnowledgeFileDescriptor,
  type SupportedKnowledgeFileExtension,
} from '@/lib/system-ux'

const S = {
  panel: '#13171f', panel2: '#10141b', input: '#0f1319', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488',
  red: '#e5687a', bg: '#0c0f14',
} as const

interface AttachedKnowledgeFile {
  name: string
  size: number
  extension: SupportedKnowledgeFileExtension
  text: string
}

function formatFileSize(bytes: number) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export default function UpdateSystemComposer({
  variant = 'compact',
  onSaved,
}: {
  variant?: 'compact' | 'full'
  onSaved?: (entryId: string) => void | Promise<void>
}) {
  const [text, setText] = useState('')
  const [file, setFile] = useState<AttachedKnowledgeFile | null>(null)
  const [expanded, setExpanded] = useState(variant === 'full')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const submitGuardRef = useRef(false)

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (!selected) return

    setNotice(null)
    try {
      const validated = validateKnowledgeFileDescriptor({ name: selected.name, size: selected.size })
      const contents = await selected.text()
      if (!contents.trim()) throw new Error('The selected file has no readable text')
      if (contents.includes('\u0000')) throw new Error('This file does not look like plain text')
      if (validated.extension === 'json') {
        try {
          JSON.parse(contents)
        } catch {
          throw new Error('JSON file is not valid JSON')
        }
      }

      setFile({ ...validated, text: contents })
      setExpanded(true)
    } catch (error) {
      setFile(null)
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Could not read this file' })
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitGuardRef.current || saving) return

    submitGuardRef.current = true
    setSaving(true)
    setNotice(null)

    try {
      const combinedText = composeKnowledgeText(text, file?.text, file?.name)
      const entryId = await ingestManualKnowledge(
        { rpc: (name, values) => supabase.rpc(name, values) },
        {
          entryType: file ? 'note' : 'life_update',
          text: combinedText,
          title: file ? file.name.slice(0, 300) : undefined,
          occurredAt: new Date().toISOString(),
          metadata: file
            ? {
                ingestion: 'system_update_composer',
                input: text.trim() ? 'text_with_file' : 'file',
                fileName: file.name,
                fileExtension: file.extension,
                fileSizeBytes: file.size,
              }
            : {
                ingestion: 'system_update_composer',
                input: 'text',
              },
        },
      )

      setText('')
      setFile(null)
      setNotice({
        tone: 'success',
        text: 'Saved to Life Vault. System will collect nearby updates before processing.',
      })
      if (variant === 'compact') setExpanded(false)
      await onSaved?.(entryId)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Could not save this update' })
    } finally {
      setSaving(false)
      submitGuardRef.current = false
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  const hasContent = Boolean(text.trim() || file)
  const showExpanded = variant === 'full' || expanded || hasContent || Boolean(notice)

  return (
    <section aria-label="Update System">
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9, fontWeight: 700, letterSpacing: '.14em' }}>UPDATE SYSTEM</div>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8.5, letterSpacing: '.05em' }}>TXT · MD · JSON · ≤ {Math.round(MAX_KNOWLEDGE_FILE_BYTES / 1024)} KB</div>
      </div>

      <form
        onSubmit={submit}
        style={{
          border: `1px solid ${showExpanded ? S.lineStrong : S.line}`,
          background: S.panel,
          borderRadius: 16,
          padding: showExpanded ? '13px' : '9px 10px',
          boxShadow: showExpanded ? '0 14px 44px rgba(0,0,0,.14)' : 'none',
          transition: 'border-color 160ms ease, padding 160ms ease, box-shadow 160ms ease',
        }}
      >
        <label htmlFor="system-update-text" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>
          Tell the System anything
        </label>
        <textarea
          id="system-update-text"
          value={text}
          onChange={(event) => { setText(event.target.value); setNotice(null) }}
          onFocus={() => setExpanded(true)}
          onKeyDown={handleKeyDown}
          maxLength={MAX_KNOWLEDGE_TEXT_LENGTH}
          disabled={saving}
          rows={showExpanded ? (variant === 'full' ? 6 : 3) : 1}
          placeholder="Tell the System anything…"
          style={{
            boxSizing: 'border-box', width: '100%', minHeight: showExpanded ? (variant === 'full' ? 150 : 82) : 42,
            maxHeight: 300, resize: showExpanded ? 'vertical' : 'none', border: 'none', outline: 'none',
            background: 'transparent', color: S.ink, padding: showExpanded ? '4px 3px 8px' : '10px 4px',
            fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 16, lineHeight: 1.5,
          }}
        />

        {file && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '2px 0 10px', padding: '9px 10px', borderRadius: 10, border: `1px solid ${S.line}`, background: S.panel2 }}>
            <div aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: '#1b2029', color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700 }}>{file.extension.toUpperCase()}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: S.ink, fontSize: 12.5 }}>{file.name}</div>
              <div style={{ marginTop: 2, color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>{formatFileSize(file.size)} · imported as text knowledge</div>
            </div>
            <button type="button" onClick={() => setFile(null)} disabled={saving} aria-label={`Remove ${file.name}`} style={{ width: 34, height: 34, border: 'none', borderRadius: 9, background: 'transparent', color: S.muted, cursor: saving ? 'default' : 'pointer', fontSize: 18 }}>×</button>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.json,text/plain,text/markdown,application/json"
              onChange={(event) => { void selectFile(event) }}
              disabled={saving}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={saving}
              style={{ minHeight: 42, border: `1px solid ${S.lineStrong}`, borderRadius: 10, background: S.input, color: S.muted, padding: '0 12px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 600, letterSpacing: '.06em', cursor: saving ? 'default' : 'pointer' }}
            >
              + ATTACH FILE
            </button>
            {showExpanded && <span style={{ color: S.muted2, fontSize: 10.5 }}>⌘/Ctrl + Enter to send</span>}
          </div>

          <button
            type="submit"
            disabled={saving || !hasContent}
            style={{ minWidth: 112, minHeight: 42, border: 'none', borderRadius: 10, padding: '0 15px', background: saving || !hasContent ? '#3a3328' : S.amber, color: saving || !hasContent ? S.muted : S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 700, letterSpacing: '.08em', cursor: saving || !hasContent ? 'default' : 'pointer' }}
          >
            {saving ? 'SAVING…' : 'SEND UPDATE'}
          </button>
        </div>
      </form>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          style={{ marginTop: 8, border: `1px solid ${notice.tone === 'success' ? '#40371f' : '#4b2730'}`, borderRadius: 11, background: notice.tone === 'success' ? '#15140f' : '#181014', padding: '10px 12px', color: notice.tone === 'success' ? S.gold : S.red, fontSize: 11.5, lineHeight: 1.5 }}
        >
          {notice.text}
        </div>
      )}
    </section>
  )
}
