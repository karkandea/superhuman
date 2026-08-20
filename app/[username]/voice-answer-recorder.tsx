'use client'

import { useEffect, useRef, useState } from 'react'
import {
  MAX_INITIALIZATION_AUDIO_DURATION_MS,
  chooseRecordingMimeType,
  submitPlayerInitializationVoiceAnswer,
} from '@/lib/player-initialization-voice-service'
import { supabase } from '@/lib/supabase'

const S = {
  panel2: '#10141b', line: '#232a35', ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270',
  amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export default function VoiceAnswerRecorder({
  playerId,
  questionId,
  disabled,
  textPresent,
  onSaved,
}: {
  playerId: string
  questionId: string
  disabled: boolean
  textPresent: boolean
  onSaved: () => Promise<void>
}) {
  const [recording, setRecording] = useState(false)
  const [recorded, setRecorded] = useState<{ blob: Blob; durationMs: number; url: string } | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  function cleanupStream() {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    recorderRef.current = null
    if (timerRef.current != null) window.clearInterval(timerRef.current)
    timerRef.current = null
  }

  function clearRecorded() {
    if (recorded?.url) URL.revokeObjectURL(recorded.url)
    setRecorded(null)
    setElapsedMs(0)
  }

  useEffect(() => () => {
    cleanupStream()
    if (recorded?.url) URL.revokeObjectURL(recorded.url)
  }, [recorded?.url])

  async function startRecording() {
    if (disabled || textPresent || recording) return
    setError(null)
    clearRecorded()
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Voice recording is not supported in this browser.')
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = chooseRecordingMimeType()
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
        const durationMs = Math.min(MAX_INITIALIZATION_AUDIO_DURATION_MS, Date.now() - startedAtRef.current)
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        const url = URL.createObjectURL(blob)
        setRecorded({ blob, durationMs, url })
        setElapsedMs(durationMs)
        setRecording(false)
        cleanupStream()
      })

      recorder.start(1000)
      setRecording(true)
      timerRef.current = window.setInterval(() => {
        const next = Date.now() - startedAtRef.current
        setElapsedMs(next)
        if (next >= MAX_INITIALIZATION_AUDIO_DURATION_MS && recorder.state === 'recording') recorder.stop()
      }, 250)
    } catch (cause) {
      cleanupStream()
      setRecording(false)
      setError(cause instanceof Error ? cause.message : 'Microphone could not start.')
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
  }

  async function saveVoice() {
    if (!recorded || disabled || saving) return
    setSaving(true)
    setError(null)
    try {
      await submitPlayerInitializationVoiceAnswer(supabase, {
        playerId,
        questionId,
        audio: recorded.blob,
        durationMs: recorded.durationMs,
      })
      clearRecorded()
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Voice answer could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginTop: 11 }}>
      {!recording && !recorded && (
        <button
          type="button"
          onClick={() => { void startRecording() }}
          disabled={disabled || textPresent}
          style={{ minHeight: 40, border: `1px solid ${S.line}`, borderRadius: 11, padding: '0 14px', background: 'transparent', color: disabled || textPresent ? S.muted2 : S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, letterSpacing: '.07em', cursor: disabled || textPresent ? 'default' : 'pointer' }}
        >
          ● RECORD VOICE ANSWER
        </button>
      )}

      {recording && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 11px', border: `1px solid ${S.line}`, borderRadius: 12, background: S.panel2 }}>
          <span style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.red, fontSize: 9, letterSpacing: '.08em' }}>● RECORDING · {formatDuration(elapsedMs)}</span>
          <button type="button" onClick={stopRecording} style={{ border: 0, borderRadius: 9, minHeight: 34, padding: '0 11px', background: S.amber, color: '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, cursor: 'pointer' }}>STOP</button>
          <span style={{ color: S.muted2, fontSize: 10 }}>Max 5:00</span>
        </div>
      )}

      {recorded && !recording && (
        <div style={{ padding: '11px 12px', border: `1px solid ${S.line}`, borderRadius: 12, background: S.panel2 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontSize: 9, letterSpacing: '.06em' }}>▶ VOICE ANSWER · {formatDuration(recorded.durationMs)}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={clearRecorded} disabled={saving} style={{ border: 0, background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: saving ? 'default' : 'pointer' }}>DELETE</button>
              <button type="button" onClick={() => { void saveVoice() }} disabled={saving || disabled} style={{ border: 0, borderRadius: 9, minHeight: 34, padding: '0 11px', background: saving || disabled ? '#2a2f37' : S.amber, color: saving || disabled ? S.muted2 : '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, cursor: saving || disabled ? 'default' : 'pointer' }}>{saving ? 'SAVING…' : 'USE VOICE ANSWER'}</button>
            </div>
          </div>
          <audio controls src={recorded.url} style={{ width: '100%', height: 32, marginTop: 9 }} />
        </div>
      )}

      {textPresent && !recording && !recorded && (
        <div style={{ color: S.muted2, fontSize: 10, marginTop: 5 }}>Clear the typed answer first if you want to answer with voice instead.</div>
      )}
      {error && <div role="alert" style={{ marginTop: 8, color: S.red, fontSize: 10.5, lineHeight: 1.45 }}>{error}</div>}
    </div>
  )
}
