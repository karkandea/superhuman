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
import VoiceAnswerRecorder from './voice-answer-recorder'

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b',
  gold: '#ffd488', red: '#e5687a',
} as const

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))

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
  playerName,
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
  const [jobStatus, setJobStatus] = useState<AiInferenceJobStatus | 'idle'>('idle')
  const [error, setError] = useState<string | null>(null)
  const watchedJobRef = useRef<string | null>(null)

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
  const progress = totalBasic ? Math.round((addressedBasic / totalBasic) * 100) : 0
  const busy = saving || jobStatus === 'queued' || jobStatus === 'running'
  const calibrating = question?.origin === 'adaptive' || state?.stage === 'calibrating'

  useEffect(() => { setAnswer('') }, [question?.id])

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

  async function submit() {
    if (!question || !answer.trim() || busy) return
    setSaving(true)
    setError(null)
    try {
      await answerPlayerInitializationQuestion(supabase, question.id, answer)
      setAnswer('')
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Answer could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  async function skip() {
    if (!question || busy) return
    setSaving(true)
    setError(null)
    try {
      await skipPlayerInitializationQuestion(supabase, question.id)
      setAnswer('')
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Question could not be skipped.')
    } finally {
      setSaving(false)
    }
  }

  async function calibrate() {
    if (busy) return
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
    if (busy) return
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
        INITIALIZING PLAYER…
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', padding: '0 18px 72px' }}>
      <main style={{ width: '100%', maxWidth: 620, margin: '0 auto', paddingTop: 46 }}>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9.5, fontWeight: 700, letterSpacing: '.18em' }}>
          {calibrating ? 'CALIBRATING' : 'INITIALIZING PLAYER'}
        </div>
        <div style={{ marginTop: 5, fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 10 }}>
          PLAYER · {playerName.toUpperCase()}
        </div>

        <h1 style={{ margin: '24px 0 0', maxWidth: 560, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(32px,8vw,46px)', lineHeight: 1, letterSpacing: '-.045em' }}>
          {calibrating ? 'The System only asks for what changes the decision.' : 'Give the System enough reality to work with.'}
        </h1>
        <p style={{ maxWidth: 520, margin: '13px 0 0', color: S.muted, fontSize: 13, lineHeight: 1.65 }}>
          {calibrating
            ? 'One question at a time. It stops when Direction, Current State, leverage, and realistic capacity are clear enough.'
            : 'Type it or talk it out. Voice stays raw until the calibration cycle reads it together with your other answers.'}
        </p>

        {question?.origin === 'basic' && totalBasic > 0 && (
          <div style={{ marginTop: 26 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.muted2 }}>
              <span>BASE CONTEXT</span><span>{addressedBasic}/{totalBasic}</span>
            </div>
            <div style={{ height: 4, marginTop: 7, borderRadius: 99, overflow: 'hidden', background: '#1c222c' }}>
              <div style={{ width: `${progress}%`, height: '100%', background: S.amber, transition: 'width 220ms ease' }} />
            </div>
          </div>
        )}

        {question ? (
          <section style={{ marginTop: 28, padding: '20px 18px', background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: question.origin === 'adaptive' ? S.gold : S.muted, fontSize: 8.5, letterSpacing: '.13em' }}>
              {question.origin === 'adaptive' ? 'SYSTEM QUESTION' : 'PLAYER CONTEXT'}
            </div>
            <div style={{ marginTop: 10, fontFamily: '"Space Grotesk", sans-serif', fontSize: 22, fontWeight: 650, lineHeight: 1.22, letterSpacing: '-.025em' }}>
              {question.prompt}
            </div>
            <textarea
              value={answer}
              onChange={event => setAnswer(event.target.value)}
              disabled={busy}
              placeholder="Jawab dengan bahasa lo sendiri…"
              rows={5}
              maxLength={5000}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 126, marginTop: 18, border: `1px solid ${S.line}`, borderRadius: 13, background: S.panel2, color: S.ink, padding: '13px 14px', outline: 'none', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 13.5, lineHeight: 1.55 }}
            />
            <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ height: 1, flex: 1, background: S.line }} />
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.muted2, letterSpacing: '.08em' }}>OR TALK TO THE SYSTEM</div>
              <div style={{ height: 1, flex: 1, background: S.line }} />
            </div>
            <VoiceAnswerRecorder
              key={question.id}
              playerId={playerId}
              questionId={question.id}
              disabled={busy}
              textPresent={Boolean(answer.trim())}
              onSaved={async () => {
                setAnswer('')
                await reload()
              }}
            />
            <div style={{ display: 'flex', gap: 9, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => { void submit() }} disabled={busy || !answer.trim()} style={{ minHeight: 42, border: 0, borderRadius: 11, padding: '0 16px', background: busy || !answer.trim() ? '#2a2f37' : S.amber, color: busy || !answer.trim() ? S.muted2 : '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 800, letterSpacing: '.08em', cursor: busy || !answer.trim() ? 'default' : 'pointer' }}>
                {saving ? 'SAVING…' : 'CONTINUE WITH TEXT'}
              </button>
              <button type="button" onClick={() => { void skip() }} disabled={busy} style={{ minHeight: 42, border: `1px solid ${S.line}`, borderRadius: 11, padding: '0 14px', background: 'transparent', color: busy ? S.muted2 : S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, letterSpacing: '.06em', cursor: busy ? 'default' : 'pointer' }}>
                SKIP
              </button>
            </div>
            <div style={{ marginTop: 12, color: S.muted2, fontSize: 10.5, lineHeight: 1.5 }}>
              Text or raw audio becomes Life Vault evidence. Saving alone does not trigger AI reasoning; calibration reads the saved batch once.
            </div>
          </section>
        ) : state.readiness !== 'ready' ? (
          <section style={{ marginTop: 28, padding: '20px 18px', background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.13em' }}>
              {jobStatus === 'queued' || jobStatus === 'running' ? 'CALIBRATING' : 'DECISION READINESS'}
            </div>
            <div style={{ marginTop: 9, fontFamily: '"Space Grotesk", sans-serif', fontSize: 21, fontWeight: 700, lineHeight: 1.25 }}>
              {jobStatus === 'queued' || jobStatus === 'running'
                ? 'The System is deciding whether it knows enough.'
                : answeredThisCycle === 0
                  ? 'The System still needs one useful answer before it can reason again.'
                  : 'Your saved context is ready for one reasoning cycle.'}
            </div>
            <div style={{ marginTop: 8, color: S.muted, fontSize: 12.5, lineHeight: 1.6 }}>
              {jobStatus === 'queued' || jobStatus === 'running'
                ? 'Text and voice answers are understood together. Voice transcription, when needed, is produced inside this same calibration call.'
                : answeredThisCycle === 0
                  ? 'Skipped questions stay skipped. Reopen them only when you want to add evidence; the System will not call AI just because a cycle exists.'
                  : 'This is the decision point: evidence may now be assimilated and the System can return ASK or READY. No quest is generated here.'}
            </div>
            {jobStatus !== 'queued' && jobStatus !== 'running' && answeredThisCycle > 0 && (
              <button type="button" onClick={() => { void calibrate() }} disabled={busy} style={{ minHeight: 44, marginTop: 15, border: 0, borderRadius: 11, padding: '0 16px', background: busy ? '#2a2f37' : S.amber, color: busy ? S.muted2 : '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 800, letterSpacing: '.08em', cursor: busy ? 'default' : 'pointer' }}>
                {saving ? 'STARTING…' : state.calibrationVersion > 0 ? 'RE-CALIBRATE SYSTEM' : 'CALIBRATE SYSTEM'}
              </button>
            )}
            {answeredThisCycle === 0 && skippedThisCycle > 0 && (
              <button type="button" onClick={() => { void reviewSkipped() }} disabled={busy} style={{ minHeight: 42, marginTop: 15, border: `1px solid ${S.line}`, borderRadius: 11, padding: '0 14px', background: 'transparent', color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, fontWeight: 700, letterSpacing: '.06em', cursor: busy ? 'default' : 'pointer' }}>
                REVIEW SKIPPED QUESTIONS
              </button>
            )}
          </section>
        ) : null}

        {state.readinessReason && state.calibrationVersion > 0 && (
          <div style={{ marginTop: 13, padding: '12px 13px', border: `1px solid ${S.line}`, borderRadius: 13, background: S.panel2 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8, letterSpacing: '.1em' }}>LAST SYSTEM ASSESSMENT</div>
            <div style={{ marginTop: 5, color: S.muted, fontSize: 11.5, lineHeight: 1.55 }}>{state.readinessReason}</div>
          </div>
        )}

        {error && <div role="alert" style={{ marginTop: 13, padding: '11px 12px', border: '1px solid #482631', borderRadius: 12, background: '#171116', color: S.red, fontSize: 11.5, lineHeight: 1.5 }}>{error}</div>}
        <div style={{ marginTop: 18, color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, lineHeight: 1.55 }}>
          PROGRESS IS SAVED · YOU CAN CONTINUE LATER
        </div>
      </main>
    </div>
  )
}
