'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAiInferenceJob, type AiInferenceJobStatus } from '@/lib/ai/inference-job-service'
import {
  answerPlayerInitializationQuestion,
  ensurePlayerInitialization,
  loadPlayerInitialization,
  requestPlayerInitializationCalibration,
  resetSkippedPlayerInitializationQuestions,
  skipPlayerInitializationQuestion,
  type PlayerInitializationQuestion,
  type PlayerInitializationState,
} from '@/lib/player-initialization-service'
import { supabase } from '@/lib/supabase'
import VoiceAnswerRecorder, {
  type VoiceAnswerRecorderHandle,
  type VoiceRecorderState,
} from './voice-answer-recorder'

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b',
  gold: '#ffd488', red: '#e5687a',
} as const

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))

const BASIC_QUESTION_HELPERS: Record<string, string> = {
  life_context: 'Lagi kerja, kuliah, ngurus sesuatu, atau ada hal lain yang paling banyak makan waktu lo?',
  current_direction: 'Pilih satu yang paling pengen lo dorong dulu.',
  major_constraint: 'Bisa waktu, tenaga, uang, bingung mulai dari mana, atau hal lain.',
}

function nextQuestion(questions: PlayerInitializationQuestion[]) {
  return [...questions]
    .filter(question => question.status === 'pending')
    .sort((left, right) => {
      if (left.origin !== right.origin) return left.origin === 'basic' ? -1 : 1
      if (left.origin === 'adaptive' && left.priority !== right.priority) return right.priority - left.priority
      return left.sequence - right.sequence
    })[0] ?? null
}

export default function PlayerInitialization({
  playerId,
  onReady,
}: {
  playerId: string
  playerName: string
  onReady: () => void
}) {
  const [state, setState] = useState<PlayerInitializationState | null>(null)
  const [questions, setQuestions] = useState<PlayerInitializationQuestion[]>([])
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [introDismissed, setIntroDismissed] = useState(false)
  const [voiceState, setVoiceState] = useState<VoiceRecorderState>('idle')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<AiInferenceJobStatus | 'idle'>('idle')
  const [error, setError] = useState<string | null>(null)
  const watchedJobRef = useRef<string | null>(null)
  const voiceRef = useRef<VoiceAnswerRecorderHandle | null>(null)

  const reload = useCallback(async () => {
    await ensurePlayerInitialization(supabase)
    const next = await loadPlayerInitialization(supabase, playerId)
    setState(next.state)
    setQuestions(next.questions)
    if (next.state.readiness === 'ready') onReady()
    return next
  }, [onReady, playerId])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void reload()
        .catch(cause => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : 'Player initialization could not load.')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [reload])

  const question = useMemo(() => nextQuestion(questions), [questions])
  const totalBasic = questions.filter(item => item.origin === 'basic').length
  const addressedBasic = questions.filter(item => item.origin === 'basic' && item.status !== 'pending').length
  const currentCalibrationVersion = state?.calibrationVersion ?? 0
  const answeredThisCycle = questions.filter(item => item.status === 'answered' && item.calibrationVersion === currentCalibrationVersion).length
  const skippedThisCycle = questions.filter(item => item.status === 'skipped' && item.calibrationVersion === currentCalibrationVersion).length
  const isBasicQuestion = question?.origin === 'basic'
  const questionNumber = isBasicQuestion ? Math.min(addressedBasic + 1, Math.max(totalBasic, 1)) : null
  const progress = totalBasic ? Math.round((addressedBasic / totalBasic) * 100) : 0
  const systemBusy = saving || jobStatus === 'queued' || jobStatus === 'running'
  const voiceBusy = voiceState === 'privacy' || voiceState === 'recording' || voiceState === 'saving'
  const hasVoiceDraft = voiceState === 'ready'
  const hasTextAnswer = Boolean(answer.trim())
  const canContinue = !systemBusy && !voiceBusy && (hasTextAnswer || hasVoiceDraft)
  const canSkip = !systemBusy && voiceState === 'idle'
  const showIntro = !introDismissed && addressedBasic === 0 && currentCalibrationVersion === 0 && isBasicQuestion
  const questionHelper = question
    ? question.origin === 'basic'
      ? BASIC_QUESTION_HELPERS[question.questionKey] ?? null
      : 'Ceritain dengan bahasa lo sendiri. Nggak perlu dirapihin.'
    : null

  const watchJob = useCallback(async (jobId: string) => {
    if (watchedJobRef.current === jobId) return
    watchedJobRef.current = jobId
    try {
      for (let index = 0; index < 120; index += 1) {
        if (index > 0) await sleep(1500)
        const job = await getAiInferenceJob(supabase, jobId)
        if (!job) throw new Error('Calibration state disappeared.')
        setJobStatus(job.status)
        if (job.status === 'succeeded') {
          setError(null)
          await reload()
          return
        }
        if (job.status === 'failed' || job.status === 'blocked_auth') {
          setError(job.errorMessage ?? 'System calibration could not finish.')
          return
        }
      }
      setJobStatus('failed')
      setError('System calibration is unresolved. Retry is safe; your answers are already saved.')
    } catch (cause) {
      setJobStatus('failed')
      setError(cause instanceof Error ? cause.message : 'System calibration could not be monitored.')
    } finally {
      watchedJobRef.current = null
    }
  }, [reload])

  async function acknowledge(message: string) {
    setFeedback(message)
    await sleep(420)
  }

  async function submit() {
    if (!question || !canContinue) return
    setError(null)

    if (hasVoiceDraft) {
      const saved = await voiceRef.current?.save()
      if (!saved) return
      await acknowledge('✓ Got it.')
      setAnswer('')
      await reload()
      setFeedback(null)
      return
    }

    setSaving(true)
    try {
      await answerPlayerInitializationQuestion(supabase, question.id, answer)
      await acknowledge('✓ Got it.')
      setAnswer('')
      await reload()
      setFeedback(null)
    } catch (cause) {
      setFeedback(null)
      setError(cause instanceof Error ? cause.message : 'Answer could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  async function skip() {
    if (!question || !canSkip) return
    setSaving(true)
    setError(null)
    try {
      await skipPlayerInitializationQuestion(supabase, question.id)
      await acknowledge('✓ Skipped.')
      setAnswer('')
      await reload()
      setFeedback(null)
    } catch (cause) {
      setFeedback(null)
      setError(cause instanceof Error ? cause.message : 'Question could not be skipped.')
    } finally {
      setSaving(false)
    }
  }

  async function calibrate() {
    if (systemBusy || voiceState !== 'idle') return
    setSaving(true)
    setError(null)
    try {
      const job = await requestPlayerInitializationCalibration(supabase)
      setJobStatus(job.status)
      if (job.status === 'succeeded') await reload()
      else if (job.status !== 'failed' && job.status !== 'blocked_auth') void watchJob(job.id)
      else setError(job.errorMessage ?? 'System calibration could not start.')
    } catch (cause) {
      setJobStatus('failed')
      setError(cause instanceof Error ? cause.message : 'System calibration could not start.')
    } finally {
      setSaving(false)
    }
  }

  async function reviewSkipped() {
    if (systemBusy || voiceState !== 'idle') return
    setSaving(true)
    setError(null)
    try {
      await resetSkippedPlayerInitializationQuestions(supabase)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Skipped questions could not be restored.')
    } finally {
      setSaving(false)
    }
  }

  if (loading || !state) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, color: S.muted, display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, letterSpacing: '.12em' }}>
        SYSTEM CALIBRATION…
      </div>
    )
  }

  if (showIntro) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Sans", sans-serif', padding: '24px 18px 72px' }}>
        <main style={{ width: '100%', maxWidth: 560 }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9, fontWeight: 700, letterSpacing: '.17em' }}>SYSTEM CALIBRATION</div>
          <div aria-hidden="true" style={{ marginTop: 14, width: 44, height: 2, background: S.amber, boxShadow: '0 0 18px rgba(246,178,75,.35)' }} />
          <h1 style={{ margin: '26px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(38px,10vw,58px)', lineHeight: .98, letterSpacing: '-.05em', maxWidth: 520 }}>
            Let the System understand you.
          </h1>
          <p style={{ margin: '16px 0 0', maxWidth: 430, color: S.muted, fontSize: 14, lineHeight: 1.65 }}>
            Jawab {totalBasic || 5} pertanyaan singkat. Bisa ketik atau ngomong.
          </p>
          <button type="button" onClick={() => setIntroDismissed(true)} style={{ width: '100%', minHeight: 50, marginTop: 30, border: 0, borderRadius: 13, background: S.amber, color: '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', cursor: 'pointer' }}>
            BEGIN CALIBRATION →
          </button>
        </main>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', padding: '0 18px 72px' }}>
      <main style={{ width: '100%', maxWidth: 620, margin: '0 auto', paddingTop: 34 }}>
        {question && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, fontWeight: 700, letterSpacing: '.15em' }}>SYSTEM CALIBRATION</div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: question.origin === 'adaptive' ? S.gold : S.muted, fontSize: 8.5, fontWeight: 700, letterSpacing: '.08em' }}>
                {questionNumber ? `${questionNumber} / ${totalBasic}` : 'FOLLOW-UP'}
              </div>
            </div>
            <div style={{ height: 4, marginTop: 11, borderRadius: 99, overflow: 'hidden', background: '#1b212a' }}>
              <div style={{ width: `${question.origin === 'adaptive' ? 100 : progress}%`, height: '100%', borderRadius: 99, background: S.amber, boxShadow: '0 0 15px rgba(246,178,75,.3)', transition: 'width 280ms ease' }} />
            </div>
          </>
        )}

        {question ? (
          <section style={{ marginTop: 'clamp(46px,9vh,82px)' }}>
            {feedback ? (
              <div aria-live="polite" style={{ minHeight: 280, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
                <div>
                  <div style={{ width: 48, height: 48, margin: '0 auto', display: 'grid', placeItems: 'center', border: `1px solid ${S.line}`, borderRadius: 16, color: S.amber, background: S.panel, fontSize: 20 }}>✓</div>
                  <div style={{ marginTop: 15, color: S.ink, fontFamily: '"Space Grotesk", sans-serif', fontSize: 23, fontWeight: 700 }}>{feedback.replace('✓ ', '')}</div>
                </div>
              </div>
            ) : (
              <>
                <h1 style={{ margin: 0, maxWidth: 590, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(30px,7.4vw,44px)', fontWeight: 700, lineHeight: 1.08, letterSpacing: '-.04em' }}>
                  {question.prompt}
                </h1>
                {questionHelper && (
                  <p style={{ margin: '12px 0 0', maxWidth: 520, color: S.muted, fontSize: 12.5, lineHeight: 1.55 }}>
                    {questionHelper}
                  </p>
                )}

                <div style={{ position: 'relative', minHeight: 132, marginTop: 26, border: `1px solid ${voiceState === 'recording' ? '#4a3a23' : S.line}`, borderRadius: 16, background: S.panel2, overflow: 'hidden', transition: 'border-color 180ms ease, box-shadow 180ms ease', boxShadow: voiceState === 'recording' ? '0 0 0 1px rgba(246,178,75,.08), 0 16px 42px rgba(0,0,0,.16)' : 'none' }}>
                  {voiceState === 'idle' && (
                    <textarea
                      value={answer}
                      onChange={event => setAnswer(event.target.value)}
                      disabled={systemBusy}
                      placeholder="Ceritain di sini…"
                      rows={5}
                      maxLength={5000}
                      autoFocus
                      style={{ width: '100%', minHeight: 132, boxSizing: 'border-box', resize: 'none', border: 0, background: 'transparent', color: S.ink, padding: '15px 58px 15px 15px', outline: 'none', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 14, lineHeight: 1.6 }}
                    />
                  )}
                  <VoiceAnswerRecorder
                    key={question.id}
                    ref={voiceRef}
                    playerId={playerId}
                    questionId={question.id}
                    disabled={systemBusy}
                    textPresent={hasTextAnswer}
                    onStateChange={setVoiceState}
                  />
                </div>

                {!voiceBusy && (
                  <button type="button" onClick={() => { void submit() }} disabled={!canContinue} style={{ width: '100%', minHeight: 49, marginTop: 14, border: 0, borderRadius: 13, background: canContinue ? S.amber : '#252b34', color: canContinue ? '#17120a' : S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', cursor: canContinue ? 'pointer' : 'default', transition: 'background 160ms ease, color 160ms ease, transform 160ms ease' }}>
                    {saving ? 'SAVING…' : 'LANJUT →'}
                  </button>
                )}
                {voiceState === 'idle' && (
                  <button type="button" onClick={() => { void skip() }} disabled={!canSkip} style={{ display: 'block', margin: '13px auto 0', border: 0, padding: '4px 8px', background: 'transparent', color: canSkip ? S.muted : S.muted2, fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 11.5, cursor: canSkip ? 'pointer' : 'default' }}>
                    Lewati
                  </button>
                )}
              </>
            )}
          </section>
        ) : state.readiness !== 'ready' ? (
          <section style={{ marginTop: 'clamp(62px,12vh,110px)', textAlign: 'center' }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, fontWeight: 700, letterSpacing: '.15em' }}>SYSTEM CALIBRATION</div>
            {jobStatus === 'queued' || jobStatus === 'running' ? (
              <>
                <div aria-hidden="true" style={{ width: 48, height: 48, margin: '24px auto 0', borderRadius: 16, border: `1px solid ${S.line}`, background: S.panel, display: 'grid', placeItems: 'center', color: S.amber, boxShadow: '0 0 28px rgba(246,178,75,.08)' }}>◌</div>
                <h1 style={{ margin: '17px auto 0', maxWidth: 500, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(30px,7vw,42px)', lineHeight: 1.05, letterSpacing: '-.04em' }}>Connecting the dots…</h1>
                <p style={{ margin: '11px auto 0', color: S.muted, fontSize: 12.5 }}>The System is calibrating.</p>
              </>
            ) : answeredThisCycle > 0 ? (
              <>
                <h1 style={{ margin: '18px auto 0', maxWidth: 500, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(30px,7vw,42px)', lineHeight: 1.05, letterSpacing: '-.04em' }}>Let the System connect the dots.</h1>
                <p style={{ margin: '11px auto 0', maxWidth: 420, color: S.muted, fontSize: 12.5, lineHeight: 1.55 }}>Jawaban lo udah siap. Lanjut saat lo siap.</p>
                <button type="button" onClick={() => { void calibrate() }} disabled={systemBusy} style={{ width: '100%', minHeight: 49, marginTop: 25, border: 0, borderRadius: 13, background: systemBusy ? '#252b34' : S.amber, color: systemBusy ? S.muted2 : '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', cursor: systemBusy ? 'default' : 'pointer' }}>
                  {saving ? 'STARTING…' : 'CONTINUE →'}
                </button>
              </>
            ) : skippedThisCycle > 0 ? (
              <>
                <h1 style={{ margin: '18px auto 0', maxWidth: 500, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(30px,7vw,42px)', lineHeight: 1.05, letterSpacing: '-.04em' }}>One useful answer is still missing.</h1>
                <button type="button" onClick={() => { void reviewSkipped() }} disabled={systemBusy} style={{ width: '100%', minHeight: 49, marginTop: 25, border: 0, borderRadius: 13, background: systemBusy ? '#252b34' : S.amber, color: systemBusy ? S.muted2 : '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', cursor: systemBusy ? 'default' : 'pointer' }}>
                  REVIEW QUESTIONS →
                </button>
              </>
            ) : null}
          </section>
        ) : null}

        {error && <div role="alert" style={{ marginTop: 18, padding: '11px 12px', border: '1px solid #482631', borderRadius: 12, background: '#171116', color: S.red, fontSize: 11.5, lineHeight: 1.5 }}>{error}</div>}
      </main>
    </div>
  )
}
