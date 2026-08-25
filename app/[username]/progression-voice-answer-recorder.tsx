'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ingestVoiceKnowledge,
  MAX_KNOWLEDGE_AUDIO_DURATION_MS,
  chooseKnowledgeRecordingMimeType,
} from '@/lib/player-knowledge-voice-service'
import { answerProgressionQuestionWithVoice } from '@/lib/progression-conversation-service'
import { supabase } from '@/lib/supabase'

const S = {
  panel2: '#10141b', line: '#232a35', ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270',
  amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

const PRIVACY_SESSION_KEY = 'superhuman.system-voice-privacy-acknowledged'

type VoiceState = 'idle' | 'privacy' | 'recording' | 'ready' | 'saving'

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

export default function ProgressionVoiceAnswerRecorder({
  playerId,
  questionId,
  disabled,
  textPresent,
  onAnswered,
}: {
  playerId: string
  questionId: string
  disabled: boolean
  textPresent: boolean
  onAnswered: () => Promise<unknown>
}) {
  const [state, setState] = useState<VoiceState>('idle')
  const [recorded, setRecorded] = useState<{ blob: Blob; durationMs: number; url: string } | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordedUrlRef = useRef<string | null>(null)
  const startedAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)

  function cleanupStream() {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    recorderRef.current = null
    if (timerRef.current != null) window.clearInterval(timerRef.current)
    timerRef.current = null
  }

  function clearRecorded(nextState: VoiceState = 'idle') {
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
    recordedUrlRef.current = null
    setRecorded(null)
    setElapsedMs(0)
    setState(nextState)
  }

  useEffect(() => () => {
    cleanupStream()
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
  }, [])

  async function startRecording() {
    if (disabled || textPresent || state === 'recording' || state === 'saving') return
    setError(null)
    clearRecorded('idle')
    cancelledRef.current = false
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

      recorder.addEventListener('dataavailable', event => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      })
      recorder.addEventListener('stop', () => {
        const wasCancelled = cancelledRef.current
        cancelledRef.current = false
        const durationMs = Math.min(MAX_KNOWLEDGE_AUDIO_DURATION_MS, Date.now() - startedAtRef.current)
        const chunks = chunksRef.current
        chunksRef.current = []
        cleanupStream()
        if (wasCancelled) {
          setState('idle')
          setElapsedMs(0)
          return
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        if (blob.size === 0) {
          setError('Rekaman kosong. Coba lagi.')
          setState('idle')
          return
        }
        const url = URL.createObjectURL(blob)
        recordedUrlRef.current = url
        setRecorded({ blob, durationMs, url })
        setElapsedMs(durationMs)
        setState('ready')
      })

      recorder.start(1000)
      setState('recording')
      timerRef.current = window.setInterval(() => {
        const next = Date.now() - startedAtRef.current
        setElapsedMs(next)
        if (next >= MAX_KNOWLEDGE_AUDIO_DURATION_MS && recorder.state === 'recording') recorder.stop()
      }, 250)
    } catch (cause) {
      cleanupStream()
      setState('idle')
      setError(cause instanceof Error ? cause.message : 'Microphone belum bisa digunakan.')
    }
  }

  function requestRecording() {
    if (disabled || textPresent) return
    const acknowledged = typeof window !== 'undefined' && window.sessionStorage.getItem(PRIVACY_SESSION_KEY) === '1'
    if (acknowledged) void startRecording()
    else {
      setError(null)
      setState('privacy')
    }
  }

  function cancelRecording() {
    cancelledRef.current = true
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
    else {
      cleanupStream()
      clearRecorded('idle')
    }
  }

  async function saveVoice() {
    if (!recorded || disabled || state !== 'ready') return
    setState('saving')
    setError(null)
    try {
      const knowledgeEntryId = await ingestVoiceKnowledge(supabase, {
        playerId,
        audio: recorded.blob,
        durationMs: recorded.durationMs,
        occurredAt: new Date().toISOString(),
      })
      await answerProgressionQuestionWithVoice(supabase, questionId, knowledgeEntryId)
      clearRecorded('idle')
      await onAnswered()
    } catch (cause) {
      setState('ready')
      setError(cause instanceof Error ? cause.message : 'Jawaban suara belum bisa disimpan.')
    }
  }

  if (state === 'idle') {
    return (
      <>
        <button
          type="button"
          onClick={requestRecording}
          disabled={disabled || textPresent}
          aria-label="Jawab follow-up dengan suara"
          title={textPresent ? 'Kosongkan teks dulu untuk jawab dengan suara' : 'Jawab dengan suara'}
          style={{ width: 44, height: 44, flexShrink: 0, display: 'grid', placeItems: 'center', border: `1px solid ${S.line}`, borderRadius: 12, background: '#151a22', color: disabled || textPresent ? S.muted2 : S.gold, cursor: disabled || textPresent ? 'default' : 'pointer' }}
        >
          <MicIcon />
        </button>
        {error && <div role="alert" style={{ marginTop: 7, color: S.red, fontSize: 11 }}>{error}</div>}
      </>
    )
  }

  if (state === 'privacy') {
    return (
      <div style={{ width: '100%', padding: '8px 4px 4px' }}>
        <div style={{ color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700 }}>VOICE PRIVACY</div>
        <div style={{ marginTop: 6, color: S.ink, fontSize: 12.5, lineHeight: 1.5 }}>Audio lo disimpan privat dan dipakai System sebagai jawaban untuk pertanyaan ini.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" onClick={() => { window.sessionStorage.setItem(PRIVACY_SESSION_KEY, '1'); void startRecording() }} style={{ minHeight: 40, border: 0, borderRadius: 10, padding: '0 12px', background: S.amber, color: '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800 }}>LANJUT</button>
          <button type="button" onClick={() => setState('idle')} style={{ minHeight: 40, border: 0, background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>NANTI</button>
        </div>
      </div>
    )
  }

  if (state === 'recording') {
    return (
      <div style={{ width: '100%', padding: '8px 4px 4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ color: S.red, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700 }}>● MENDENGARKAN</div>
          <div style={{ color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>{formatDuration(elapsedMs)}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button type="button" onClick={cancelRecording} style={{ minHeight: 40, border: 0, background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>BATAL</button>
          <button type="button" onClick={() => recorderRef.current?.stop()} style={{ minHeight: 40, border: 0, borderRadius: 10, padding: '0 13px', background: S.amber, color: '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800 }}>SELESAI</button>
        </div>
      </div>
    )
  }

  if (recorded) {
    return (
      <div style={{ width: '100%', padding: '6px 4px 3px' }}>
        <div style={{ color: S.ink, fontSize: 13 }}>🎙 Jawaban suara <span style={{ color: S.muted }}>· {formatDuration(recorded.durationMs)}</span></div>
        <audio src={recorded.url} controls preload="metadata" style={{ width: '100%', marginTop: 8, height: 36 }} />
        {error && <div role="alert" style={{ marginTop: 7, color: S.red, fontSize: 11 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 9 }}>
          <button type="button" onClick={() => { clearRecorded('idle'); void startRecording() }} disabled={state === 'saving'} style={{ minHeight: 40, border: 0, background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>REKAM ULANG</button>
          <button type="button" onClick={() => { void saveVoice() }} disabled={state === 'saving'} style={{ minHeight: 44, border: 0, borderRadius: 11, padding: '0 15px', background: state === 'saving' ? '#3a3328' : S.amber, color: '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800 }}>{state === 'saving' ? 'NYIMPEN…' : 'KIRIM SUARA →'}</button>
        </div>
      </div>
    )
  }

  return null
}
