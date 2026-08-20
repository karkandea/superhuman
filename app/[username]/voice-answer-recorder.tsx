'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
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

const PRIVACY_SESSION_KEY = 'superhuman.voice-privacy-acknowledged'

export type VoiceRecorderState = 'idle' | 'privacy' | 'recording' | 'ready' | 'saving'

export interface VoiceAnswerRecorderHandle {
  save: () => Promise<boolean>
  reset: () => void
}

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

const VoiceAnswerRecorder = forwardRef<VoiceAnswerRecorderHandle, {
  playerId: string
  questionId: string
  disabled: boolean
  textPresent: boolean
  onStateChange: (state: VoiceRecorderState) => void
}>(function VoiceAnswerRecorder({
  playerId,
  questionId,
  disabled,
  textPresent,
  onStateChange,
}, ref) {
  const [state, setState] = useState<VoiceRecorderState>('idle')
  const [recorded, setRecorded] = useState<{ blob: Blob; durationMs: number; url: string } | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordedUrlRef = useRef<string | null>(null)
  const startedAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  function publish(next: VoiceRecorderState) {
    setState(next)
    onStateChange(next)
  }

  function cleanupStream() {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    recorderRef.current = null
    if (timerRef.current != null) window.clearInterval(timerRef.current)
    timerRef.current = null
  }

  function clearRecorded(notify = true) {
    audioRef.current?.pause()
    setPlaying(false)
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
    recordedUrlRef.current = null
    setRecorded(null)
    setElapsedMs(0)
    if (notify) publish('idle')
  }

  useEffect(() => () => {
    cleanupStream()
    audioRef.current?.pause()
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
    recordedUrlRef.current = null
    onStateChange('idle')
  }, [onStateChange])

  async function startRecording() {
    if (disabled || textPresent || state === 'recording' || state === 'saving') return
    setError(null)
    clearRecorded(false)
    cancelledRef.current = false
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Voice recording belum didukung di browser ini.')
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
        const wasCancelled = cancelledRef.current
        cancelledRef.current = false
        const durationMs = Math.min(MAX_INITIALIZATION_AUDIO_DURATION_MS, Date.now() - startedAtRef.current)
        const chunks = chunksRef.current
        chunksRef.current = []
        setState('idle')
        setElapsedMs(wasCancelled ? 0 : durationMs)
        cleanupStream()

        if (wasCancelled) {
          onStateChange('idle')
          return
        }

        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        if (blob.size === 0) {
          setError('Rekaman kosong. Coba lagi.')
          onStateChange('idle')
          return
        }
        const url = URL.createObjectURL(blob)
        recordedUrlRef.current = url
        setRecorded({ blob, durationMs, url })
        publish('ready')
      })

      recorder.start(1000)
      publish('recording')
      timerRef.current = window.setInterval(() => {
        const next = Date.now() - startedAtRef.current
        setElapsedMs(next)
        if (next >= MAX_INITIALIZATION_AUDIO_DURATION_MS && recorder.state === 'recording') recorder.stop()
      }, 250)
    } catch (cause) {
      cleanupStream()
      publish('idle')
      setError(cause instanceof Error ? cause.message : 'Microphone nggak bisa dimulai.')
    }
  }

  function requestRecording() {
    if (disabled || textPresent) return
    const acknowledged = typeof window !== 'undefined' && window.sessionStorage.getItem(PRIVACY_SESSION_KEY) === '1'
    if (acknowledged) {
      void startRecording()
      return
    }
    setError(null)
    publish('privacy')
  }

  function acceptPrivacy() {
    if (typeof window !== 'undefined') window.sessionStorage.setItem(PRIVACY_SESSION_KEY, '1')
    void startRecording()
  }

  function cancelPrivacy() {
    publish('idle')
  }

  function finishRecording() {
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
  }

  function cancelRecording() {
    const recorder = recorderRef.current
    cancelledRef.current = true
    if (recorder?.state === 'recording') recorder.stop()
    else {
      cleanupStream()
      publish('idle')
    }
  }

  function reRecord() {
    clearRecorded(false)
    void startRecording()
  }

  function typeInstead() {
    clearRecorded()
  }

  async function togglePlayback() {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      await audio.play()
      setPlaying(true)
    } else {
      audio.pause()
      setPlaying(false)
    }
  }

  async function saveVoice() {
    if (!recorded || disabled || state !== 'ready') return false
    publish('saving')
    setError(null)
    try {
      await submitPlayerInitializationVoiceAnswer(supabase, {
        playerId,
        questionId,
        audio: recorded.blob,
        durationMs: recorded.durationMs,
      })
      clearRecorded(false)
      publish('idle')
      return true
    } catch (cause) {
      publish('ready')
      setError(cause instanceof Error ? cause.message : 'Voice answer belum bisa disimpan.')
      return false
    }
  }

  useImperativeHandle(ref, () => ({
    save: saveVoice,
    reset: () => clearRecorded(),
  }))

  if (state === 'idle') {
    return (
      <>
        <button
          type="button"
          onClick={requestRecording}
          disabled={disabled || textPresent}
          aria-label="Record voice answer"
          title={textPresent ? 'Hapus teks dulu untuk jawab dengan suara' : 'Jawab dengan suara'}
          style={{ position: 'absolute', right: 12, bottom: 12, width: 40, height: 40, display: 'grid', placeItems: 'center', border: `1px solid ${S.line}`, borderRadius: 12, background: '#151a22', color: disabled || textPresent ? S.muted2 : S.gold, cursor: disabled || textPresent ? 'default' : 'pointer' }}
        >
          <MicIcon />
        </button>
        {error && <div role="alert" style={{ position: 'absolute', left: 14, right: 62, bottom: 13, color: S.red, fontSize: 10.5, lineHeight: 1.4 }}>{error}</div>}
      </>
    )
  }

  if (state === 'privacy') {
    return (
      <div style={{ padding: '16px 16px 15px' }}>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontSize: 8.5, fontWeight: 700, letterSpacing: '.12em' }}>VOICE PRIVACY</div>
        <div style={{ marginTop: 7, color: S.ink, fontSize: 13, lineHeight: 1.55 }}>Voice answers disimpan dengan aman dan dipakai untuk mempersonalisasi System lo.</div>
        <div style={{ marginTop: 13, display: 'flex', gap: 8 }}>
          <button type="button" onClick={acceptPrivacy} style={{ minHeight: 38, border: 0, borderRadius: 10, padding: '0 13px', background: S.amber, color: '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, cursor: 'pointer' }}>CONTINUE</button>
          <button type="button" onClick={cancelPrivacy} style={{ minHeight: 38, border: 0, background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: 'pointer' }}>NOT NOW</button>
        </div>
      </div>
    )
  }

  if (state === 'recording') {
    return (
      <div style={{ padding: '15px 16px 14px' }}>
        <style jsx>{`
          @keyframes voicePulse { from { transform: scaleY(.35); opacity: .48; } to { transform: scaleY(1); opacity: 1; } }
        `}</style>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.red, fontSize: 9, fontWeight: 700, letterSpacing: '.08em' }}>● LISTENING · {formatDuration(elapsedMs)}</div>
          <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8 }}>MAX 5:00</div>
        </div>
        <div aria-hidden="true" style={{ height: 46, marginTop: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          {Array.from({ length: 24 }, (_, index) => (
            <span key={index} style={{ width: 3, height: `${12 + ((index * 11) % 28)}px`, borderRadius: 99, background: index % 5 === 0 ? S.gold : S.amber, transformOrigin: 'center', animation: `voicePulse ${520 + (index % 6) * 55}ms ease-in-out ${index * 24}ms infinite alternate` }} />
          ))}
        </div>
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={cancelRecording} style={{ minHeight: 38, border: 0, background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: 'pointer' }}>CANCEL</button>
          <button type="button" onClick={finishRecording} style={{ minHeight: 38, border: 0, borderRadius: 10, padding: '0 14px', background: S.amber, color: '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, cursor: 'pointer' }}>DONE</button>
        </div>
      </div>
    )
  }

  if (recorded) {
    return (
      <div style={{ padding: '15px 16px 14px' }}>
        <audio ref={audioRef} src={recorded.url} onEnded={() => setPlaying(false)} />
        <button type="button" onClick={() => { void togglePlayback() }} disabled={state === 'saving'} style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 38, border: 0, padding: 0, background: 'transparent', color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, letterSpacing: '.05em', cursor: state === 'saving' ? 'default' : 'pointer' }}>
          <span style={{ width: 30, height: 30, display: 'grid', placeItems: 'center', border: `1px solid ${S.line}`, borderRadius: 9, color: S.gold }}>{playing ? 'Ⅱ' : '▶'}</span>
          <span>VOICE ANSWER · {formatDuration(recorded.durationMs)}</span>
        </button>
        <div style={{ marginTop: 11, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button type="button" onClick={reRecord} disabled={state === 'saving'} style={{ border: 0, padding: 0, background: 'transparent', color: state === 'saving' ? S.muted2 : S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: state === 'saving' ? 'default' : 'pointer' }}>RE-RECORD</button>
          <button type="button" onClick={typeInstead} disabled={state === 'saving'} style={{ border: 0, padding: 0, background: 'transparent', color: state === 'saving' ? S.muted2 : S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: state === 'saving' ? 'default' : 'pointer' }}>TYPE INSTEAD</button>
          {state === 'saving' && <span style={{ marginLeft: 'auto', color: S.amber, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>SAVING…</span>}
        </div>
        {error && <div role="alert" style={{ marginTop: 9, color: S.red, fontSize: 10.5, lineHeight: 1.45 }}>{error}</div>}
      </div>
    )
  }

  return null
})

export default VoiceAnswerRecorder
