'use client'

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import { ingestManualKnowledge } from '@/lib/player-knowledge-service'
import {
  ingestVoiceKnowledge,
  MAX_KNOWLEDGE_AUDIO_DURATION_MS,
  chooseKnowledgeRecordingMimeType,
} from '@/lib/player-knowledge-voice-service'
import { supabase } from '@/lib/supabase'
import {
  composeKnowledgeText,
  MAX_KNOWLEDGE_TEXT_LENGTH,
  validateKnowledgeFileDescriptor,
  type SupportedKnowledgeFileExtension,
} from '@/lib/system-ux'

const S = {
  panel: '#13171f', panel2: '#10141b', input: '#0f1319', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488',
  red: '#e5687a', bg: '#0c0f14',
} as const

const VOICE_PRIVACY_KEY = 'superhuman.system-voice-privacy-acknowledged'

interface AttachedKnowledgeFile {
  name: string
  size: number
  extension: SupportedKnowledgeFileExtension
  text: string
}

interface VoiceDraft {
  blob: Blob
  durationMs: number
  url: string
}

type VoiceState = 'idle' | 'privacy' | 'recording' | 'ready'

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 18, height: 18, display: 'block' }}>
      <path d="M12 14.25a3.25 3.25 0 0 0 3.25-3.25V6a3.25 3.25 0 1 0-6.5 0v5A3.25 3.25 0 0 0 12 14.25Z" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6.75 10.75a5.25 5.25 0 0 0 10.5 0M12 16v3.25M9.5 19.25h5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon() {
  return <span aria-hidden="true" style={{ fontSize: 22, lineHeight: 1, marginTop: -2 }}>+</span>
}

function SendIcon() {
  return <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1 }}>↑</span>
}

export default function UpdateSystemComposer({
  playerId,
  onSaved,
  starterPrompts = [],
}: {
  playerId: string
  onSaved?: (entryId: string) => void | Promise<void>
  starterPrompts?: readonly string[]
}) {
  const [text, setText] = useState('')
  const [file, setFile] = useState<AttachedKnowledgeFile | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraft | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: 18 }, () => .18))

  const fileInputRef = useRef<HTMLInputElement>(null)
  const submitGuardRef = useRef(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const recordedUrlRef = useRef<string | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const meterFrameRef = useRef<number | null>(null)

  function stopMeter() {
    if (meterFrameRef.current != null) window.cancelAnimationFrame(meterFrameRef.current)
    meterFrameRef.current = null
    const context = audioContextRef.current
    audioContextRef.current = null
    if (context && context.state !== 'closed') void context.close().catch(() => {})
    setLevels(Array.from({ length: 18 }, () => .18))
  }

  function cleanupStream() {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    recorderRef.current = null
    if (timerRef.current != null) window.clearInterval(timerRef.current)
    timerRef.current = null
    stopMeter()
  }

  function clearVoice() {
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
    recordedUrlRef.current = null
    setVoiceDraft(null)
    setElapsedMs(0)
    setVoiceState('idle')
  }

  useEffect(() => () => {
    cleanupStream()
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
  }, [])

  function startMeter(stream: MediaStream) {
    try {
      const AudioContextCtor = window.AudioContext
      const context = new AudioContextCtor()
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = .7
      context.createMediaStreamSource(stream).connect(analyser)
      audioContextRef.current = context
      const data = new Uint8Array(analyser.fftSize)

      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const sample of data) {
          const centered = (sample - 128) / 128
          sum += centered * centered
        }
        const rms = Math.sqrt(sum / data.length)
        const energy = Math.min(1, Math.max(.08, rms * 8.5))
        setLevels(Array.from({ length: 18 }, (_, index) => {
          const wave = .48 + .52 * Math.abs(Math.sin((index + 1) * 1.37 + Date.now() / 185))
          return Math.max(.14, Math.min(1, energy * wave + .08))
        }))
        meterFrameRef.current = window.requestAnimationFrame(tick)
      }
      tick()
    } catch {
      // Recording remains fully functional even if the browser cannot expose an audio meter.
    }
  }

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (!selected || voiceState !== 'idle') return
    setNotice(null)
    try {
      const validated = validateKnowledgeFileDescriptor({ name: selected.name, size: selected.size })
      const contents = await selected.text()
      if (!contents.trim()) throw new Error('File ini kosong.')
      if (contents.includes('\u0000')) throw new Error('File ini bukan plain text yang bisa dibaca.')
      if (validated.extension === 'json') JSON.parse(contents)
      setFile({ ...validated, text: contents })
      setExpanded(true)
    } catch (error) {
      setFile(null)
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'File belum bisa dibaca.' })
    }
  }

  async function startRecording() {
    if (saving || text.trim() || file || voiceState === 'recording') return
    setNotice(null)
    clearVoice()
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Voice recording belum didukung di browser ini.')
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = chooseKnowledgeRecordingMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []
      startedAtRef.current = Date.now()
      setElapsedMs(0)
      setExpanded(true)
      startMeter(stream)

      recorder.addEventListener('dataavailable', event => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      })
      recorder.addEventListener('stop', () => {
        const durationMs = Math.min(MAX_KNOWLEDGE_AUDIO_DURATION_MS, Date.now() - startedAtRef.current)
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        const url = URL.createObjectURL(blob)
        recordedUrlRef.current = url
        setVoiceDraft({ blob, durationMs, url })
        setElapsedMs(durationMs)
        setVoiceState('ready')
        cleanupStream()
      })

      recorder.start(1000)
      setVoiceState('recording')
      timerRef.current = window.setInterval(() => {
        const next = Date.now() - startedAtRef.current
        setElapsedMs(next)
        if (next >= MAX_KNOWLEDGE_AUDIO_DURATION_MS && recorder.state === 'recording') recorder.stop()
      }, 250)
    } catch (error) {
      cleanupStream()
      setVoiceState('idle')
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Microphone belum bisa digunakan.' })
    }
  }

  function requestVoice() {
    if (saving || text.trim() || file) return
    const acknowledged = typeof window !== 'undefined' && window.sessionStorage.getItem(VOICE_PRIVACY_KEY) === '1'
    if (acknowledged) void startRecording()
    else {
      setExpanded(true)
      setVoiceState('privacy')
    }
  }

  function acceptVoicePrivacy() {
    window.sessionStorage.setItem(VOICE_PRIVACY_KEY, '1')
    void startRecording()
  }

  function cancelRecording() {
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') {
      chunksRef.current = []
      recorder.addEventListener('stop', () => clearVoice(), { once: true })
      recorder.stop()
    } else {
      cleanupStream()
      clearVoice()
    }
  }

  function finishRecording() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  function reRecord() {
    clearVoice()
    void startRecording()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitGuardRef.current || saving) return
    const hasTextOrFile = Boolean(text.trim() || file)
    if (!hasTextOrFile && !voiceDraft) return

    submitGuardRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      let entryId: string
      if (voiceDraft) {
        entryId = await ingestVoiceKnowledge(supabase, {
          playerId,
          audio: voiceDraft.blob,
          durationMs: voiceDraft.durationMs,
          occurredAt: new Date().toISOString(),
        })
      } else {
        const combinedText = composeKnowledgeText(text, file?.text, file?.name)
        entryId = await ingestManualKnowledge(
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
              : { ingestion: 'system_update_composer', input: 'text' },
          },
        )
      }

      setText('')
      setFile(null)
      clearVoice()
      setNotice({ tone: 'success', text: '✓ Saved' })
      setExpanded(false)
      window.dispatchEvent(new CustomEvent('superhuman:knowledge-saved', { detail: { entryId } }))
      try { await onSaved?.(entryId) } catch {}
      window.setTimeout(() => setNotice(current => current?.tone === 'success' ? null : current), 1400)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Update belum bisa disimpan.' })
      setExpanded(true)
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

  function chooseStarter(prompt: string) {
    if (saving || voiceState !== 'idle' || file || voiceDraft) return
    setText(prompt)
    setNotice(null)
    setExpanded(true)
  }

  const hasContent = Boolean(text.trim() || file || voiceDraft)
  const showExpanded = expanded || voiceState !== 'idle' || Boolean(file) || Boolean(notice)
  const voiceBlocked = Boolean(text.trim() || file)
  const fileBlocked = voiceState !== 'idle' || Boolean(voiceDraft)
  const showStarters = showExpanded && starterPrompts.length > 0 && !text.trim() && !file && voiceState === 'idle' && !voiceDraft && !notice

  return (
    <section aria-label="Tell the System anything" style={{ width: '100%' }}>
      <form
        onSubmit={submit}
        style={{
          border: `1px solid ${showExpanded ? S.lineStrong : S.line}`,
          background: 'rgba(19,23,31,.97)',
          borderRadius: showExpanded ? 18 : 16,
          padding: showExpanded ? '10px' : '7px 8px',
          boxShadow: '0 14px 46px rgba(0,0,0,.34)',
          backdropFilter: 'blur(18px)',
          transition: 'border-color 160ms ease, padding 160ms ease, border-radius 160ms ease',
        }}
      >
        {voiceState === 'privacy' ? (
          <div style={{ padding: '7px 6px 5px' }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontSize: 8.5, fontWeight: 700, letterSpacing: '.1em' }}>VOICE PRIVACY</div>
            <div style={{ marginTop: 6, color: S.ink, fontSize: 12.5, lineHeight: 1.5 }}>Voice updates disimpan dengan aman dan dipakai untuk mempersonalisasi System lo.</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
              <button type="button" onClick={acceptVoicePrivacy} style={{ minHeight: 36, border: 0, borderRadius: 9, padding: '0 12px', background: S.amber, color: S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, cursor: 'pointer' }}>CONTINUE</button>
              <button type="button" onClick={() => setVoiceState('idle')} style={{ minHeight: 36, border: 0, background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: 'pointer' }}>NOT NOW</button>
            </div>
          </div>
        ) : voiceState === 'recording' ? (
          <div style={{ padding: '7px 5px 5px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.red, fontSize: 9, fontWeight: 700, letterSpacing: '.08em' }}>● LISTENING</div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 9 }}>{formatDuration(elapsedMs)}</div>
            </div>
            <div aria-hidden="true" style={{ height: 34, marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
              {levels.map((level, index) => <span key={index} style={{ width: 3, height: `${Math.max(5, Math.round(level * 30))}px`, borderRadius: 99, background: index % 4 === 0 ? S.gold : S.amber, opacity: .82, transition: 'height 70ms linear' }} />)}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 7 }}>
              <button type="button" onClick={cancelRecording} style={{ minHeight: 35, border: 0, background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: 'pointer' }}>CANCEL</button>
              <button type="button" onClick={finishRecording} style={{ minHeight: 35, border: 0, borderRadius: 9, padding: '0 12px', background: S.amber, color: S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, cursor: 'pointer' }}>DONE</button>
            </div>
          </div>
        ) : voiceState === 'ready' && voiceDraft ? (
          <div style={{ padding: '6px 5px 5px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ color: S.ink, fontSize: 13 }}>🎙 Voice update <span style={{ color: S.muted }}>· {formatDuration(voiceDraft.durationMs)}</span></div>
              <button type="submit" disabled={saving} aria-label="Send voice update" style={{ width: 38, height: 38, border: 0, borderRadius: 11, background: saving ? '#3a3328' : S.amber, color: S.bg, display: 'grid', placeItems: 'center', cursor: saving ? 'default' : 'pointer' }}>{saving ? '…' : <SendIcon />}</button>
            </div>
            <audio src={voiceDraft.url} preload="metadata" style={{ display: 'none' }} />
            <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
              <button type="button" onClick={reRecord} disabled={saving} style={{ border: 0, background: 'transparent', color: S.gold, padding: 0, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, cursor: 'pointer' }}>RE-RECORD</button>
              <button type="button" onClick={clearVoice} disabled={saving} style={{ border: 0, background: 'transparent', color: S.muted, padding: 0, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, cursor: 'pointer' }}>TYPE INSTEAD</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: showExpanded ? 'flex-end' : 'center', gap: 7 }}>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={saving || fileBlocked}
                aria-label="Attach text file"
                title="Attach .txt, .md, or .json"
                style={{ width: 40, height: 40, flexShrink: 0, border: 0, borderRadius: 11, background: 'transparent', color: fileBlocked ? S.muted2 : S.muted, display: 'grid', placeItems: 'center', cursor: fileBlocked ? 'default' : 'pointer' }}
              ><PlusIcon /></button>
              <input ref={fileInputRef} type="file" accept=".txt,.md,.json,text/plain,text/markdown,application/json" onChange={(event) => { void selectFile(event) }} disabled={saving || fileBlocked} style={{ display: 'none' }} />
              <label htmlFor="universal-system-update" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>Tell the System anything</label>
              <textarea
                id="universal-system-update"
                value={text}
                onChange={event => { setText(event.target.value); setNotice(null) }}
                onFocus={() => setExpanded(true)}
                onKeyDown={handleKeyDown}
                maxLength={MAX_KNOWLEDGE_TEXT_LENGTH}
                disabled={saving}
                rows={showExpanded ? 3 : 1}
                placeholder="Tell the System anything…"
                style={{ boxSizing: 'border-box', width: '100%', minHeight: showExpanded ? 76 : 40, maxHeight: 220, resize: 'none', border: 0, outline: 0, background: 'transparent', color: S.ink, padding: showExpanded ? '9px 4px 5px' : '9px 3px', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 15.5, lineHeight: 1.45 }}
              />
              <button type="button" onClick={requestVoice} disabled={saving || voiceBlocked} aria-label="Record voice update" title={voiceBlocked ? 'Clear text/file first to record voice' : 'Record voice update'} style={{ width: 40, height: 40, flexShrink: 0, border: 0, borderRadius: 11, background: 'transparent', color: voiceBlocked ? S.muted2 : S.gold, display: 'grid', placeItems: 'center', cursor: voiceBlocked ? 'default' : 'pointer' }}><MicIcon /></button>
              {hasContent && (
                <button type="submit" disabled={saving} aria-label="Send update" style={{ width: 40, height: 40, flexShrink: 0, border: 0, borderRadius: 11, background: saving ? '#3a3328' : S.amber, color: S.bg, display: 'grid', placeItems: 'center', cursor: saving ? 'default' : 'pointer' }}>{saving ? '…' : <SendIcon />}</button>
              )}
            </div>

            {showStarters && (
              <div aria-label="Update starters" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '7px 4px 2px' }}>
                {starterPrompts.map(prompt => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => chooseStarter(prompt)}
                    style={{ border: `1px solid ${S.line}`, borderRadius: 999, background: S.panel2, color: S.muted, padding: '6px 9px', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 10.5, cursor: 'pointer' }}
                  >
                    {prompt.replace(/:\s*$/, '')}
                  </button>
                ))}
              </div>
            )}

            {file && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '7px 4px 2px', padding: '8px 9px', borderRadius: 10, border: `1px solid ${S.line}`, background: S.panel2 }}>
                <span style={{ color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>{file.extension.toUpperCase()}</span>
                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: S.ink, fontSize: 11.5 }}>{file.name}</span>
                <button type="button" onClick={() => setFile(null)} aria-label={`Remove ${file.name}`} style={{ border: 0, background: 'transparent', color: S.muted, fontSize: 17, cursor: 'pointer' }}>×</button>
              </div>
            )}
          </>
        )}
      </form>

      {notice && (
        <div role="status" aria-live="polite" style={{ marginTop: 6, textAlign: 'center', color: notice.tone === 'success' ? S.gold : S.red, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, textShadow: '0 2px 12px rgba(0,0,0,.7)' }}>
          {notice.text}
        </div>
      )}
    </section>
  )
}
