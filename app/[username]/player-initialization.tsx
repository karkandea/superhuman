'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAiInferenceJob, type AiInferenceJobStatus } from '@/lib/ai/inference-job-service'
import {
  answerPlayerInitializationQuestion,
  ensurePlayerInitialization,
  loadPlayerInitialization,
  reopenPreviousPlayerInitializationQuestion,
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
import ConversationBubble, { ConversationStatus } from './conversation-bubble'
import {
  SystemEyebrow,
  SystemMoment,
  SystemPulse,
  WaitingCopy,
} from './system-moment'

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

function conversationOrder(left: PlayerInitializationQuestion, right: PlayerInitializationQuestion) {
  if (left.origin !== right.origin) return left.origin === 'basic' ? -1 : 1
  if (left.calibrationVersion !== right.calibrationVersion) return left.calibrationVersion - right.calibrationVersion
  return left.sequence - right.sequence
}

function visiblePlayerAnswer(question: PlayerInitializationQuestion) {
  if (question.status === 'skipped') return 'Dilewati.'
  if (question.answerText?.trim()) return question.answerText.trim()
  return '🎙 Jawaban suara'
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
  const [identified, setIdentified] = useState(false)
  const [waitingSeconds, setWaitingSeconds] = useState(0)
  const [voiceState, setVoiceState] = useState<VoiceRecorderState>('idle')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<AiInferenceJobStatus | 'idle'>('idle')
  const [error, setError] = useState<string | null>(null)
  const watchedJobRef = useRef<string | null>(null)
  const voiceRef = useRef<VoiceAnswerRecorderHandle | null>(null)
  const participatedRef = useRef(false)

  const reload = useCallback(async () => {
    await ensurePlayerInitialization(supabase)
    const next = await loadPlayerInitialization(supabase, playerId)
    setState(next.state)
    setQuestions(next.questions)
    const current = nextQuestion(next.questions)
    setAnswer(current?.answerText ?? '')

    if (next.state.readiness === 'ready') {
      if (participatedRef.current) setIdentified(true)
      else onReady()
    } else {
      participatedRef.current = true
    }

    return next
  }, [onReady, playerId])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void reload()
        .catch(cause => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : 'System belum bisa dibuka.')
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

  useEffect(() => {
    if (jobStatus !== 'queued' && jobStatus !== 'running') return

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setWaitingSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)

    return () => window.clearInterval(timer)
  }, [jobStatus])

  const question = useMemo(() => nextQuestion(questions), [questions])
  const basicQuestions = useMemo(
    () => questions.filter(item => item.origin === 'basic').sort((left, right) => left.sequence - right.sequence),
    [questions],
  )
  const conversationHistory = useMemo(
    () => questions.filter(item => item.status === 'answered' || item.status === 'skipped').sort(conversationOrder),
    [questions],
  )
  const totalBasic = basicQuestions.length
  const addressedBasic = basicQuestions.filter(item => item.status !== 'pending').length
  const currentCalibrationVersion = state?.calibrationVersion ?? 0
  const answeredThisCycle = questions.filter(item => item.status === 'answered' && item.calibrationVersion === currentCalibrationVersion).length
  const skippedThisCycle = questions.filter(item => item.status === 'skipped' && item.calibrationVersion === currentCalibrationVersion).length
  const adaptiveAddressedThisCycle = questions.filter(item => item.origin === 'adaptive' && item.calibrationVersion === currentCalibrationVersion && item.status !== 'pending').length
  const isBasicQuestion = question?.origin === 'basic'
  const questionNumber = isBasicQuestion ? Math.min(addressedBasic + 1, Math.max(totalBasic, 1)) : null
  const progress = totalBasic ? Math.round((addressedBasic / totalBasic) * 100) : 0
  const systemBusy = saving || jobStatus === 'queued' || jobStatus === 'running'
  const voiceBusy = voiceState === 'privacy' || voiceState === 'recording' || voiceState === 'saving'
  const hasVoiceDraft = voiceState === 'ready'
  const hasTextAnswer = Boolean(answer.trim())
  const canContinue = !systemBusy && !voiceBusy && (hasTextAnswer || hasVoiceDraft)
  const canSkip = !systemBusy && voiceState === 'idle'
  const canGoBack = Boolean(
    state
      && currentCalibrationVersion === 0
      && state.lastCalibratedAt === null
      && state.readiness !== 'ready'
      && !systemBusy
      && voiceState === 'idle'
      && (
        question?.origin === 'basic'
          ? basicQuestions.some(item => item.status === 'answered' && item.sequence < question.sequence)
          : !question && basicQuestions.some(item => item.status === 'answered')
      ),
  )
  const showIntro = !introDismissed && addressedBasic === 0 && currentCalibrationVersion === 0 && isBasicQuestion
  const questionHelper = question
    ? question.origin === 'basic'
      ? BASIC_QUESTION_HELPERS[question.questionKey] ?? null
      : 'Ceritain dengan bahasa lo sendiri. Nggak perlu dirapihin.'
    : null
  const adaptiveLead = question?.origin === 'adaptive'
    ? adaptiveAddressedThisCycle > 0 ? 'Oke. Satu lagi.' : 'Masih ada satu yang belum kebaca.'
    : null

  const watchJob = useCallback(async (jobId: string) => {
    if (watchedJobRef.current === jobId) return
    watchedJobRef.current = jobId
    try {
      for (let index = 0; index < 120; index += 1) {
        if (index > 0) await sleep(1500)
        const job = await getAiInferenceJob(supabase, jobId)
        if (!job) throw new Error('System state disappeared.')
        setJobStatus(job.status)
        if (job.status === 'succeeded') {
          setError(null)
          await reload()
          return
        }
        if (job.status === 'failed' || job.status === 'blocked_auth') {
          setError('Ada yang keputus. Jawaban lo aman. Coba lagi.')
          return
        }
      }
      setJobStatus('failed')
      setError('Ini lebih lama dari biasanya. Jawaban lo aman; coba lagi kalau belum lanjut.')
    } catch {
      setJobStatus('failed')
      setError('Ada yang keputus. Jawaban lo aman. Coba lagi.')
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
    const message = question.origin === 'adaptive' ? '✓ Got it. Gue cek lagi.' : '✓ Got it.'

    if (hasVoiceDraft) {
      const saved = await voiceRef.current?.save()
      if (!saved) return
      await acknowledge(message)
      setAnswer('')
      await reload()
      setFeedback(null)
      return
    }

    setSaving(true)
    try {
      await answerPlayerInitializationQuestion(supabase, question.id, answer)
      await acknowledge(message)
      setAnswer('')
      await reload()
      setFeedback(null)
    } catch {
      setFeedback(null)
      setError('Jawaban belum kesimpan. Coba sekali lagi.')
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
      await acknowledge('✓ Lewat.')
      setAnswer('')
      await reload()
      setFeedback(null)
    } catch {
      setFeedback(null)
      setError('Belum bisa dilewatin. Coba sekali lagi.')
    } finally {
      setSaving(false)
    }
  }

  async function goBack() {
    if (!canGoBack) return
    setSaving(true)
    setError(null)
    try {
      const reopened = await reopenPreviousPlayerInitializationQuestion(
        supabase,
        question?.origin === 'basic' ? question.id : null,
      )
      if (!reopened) return
      voiceRef.current?.reset()
      setVoiceState('idle')
      setAnswer(reopened.answerMode === 'text' ? reopened.answerText ?? '' : '')
      await reload()
    } catch {
      setError('Jawaban sebelumnya belum bisa dibuka. Coba sekali lagi.')
    } finally {
      setSaving(false)
    }
  }

  async function calibrate() {
    if (systemBusy || voiceState !== 'idle') return
    setWaitingSeconds(0)
    setSaving(true)
    setError(null)
    try {
      const job = await requestPlayerInitializationCalibration(supabase)
      setJobStatus(job.status)
      if (job.status === 'succeeded') await reload()
      else if (job.status !== 'failed' && job.status !== 'blocked_auth') void watchJob(job.id)
      else setError('Belum bisa lanjut sekarang. Jawaban lo aman; coba lagi.')
    } catch {
      setJobStatus('failed')
      setError('Belum bisa lanjut sekarang. Jawaban lo aman; coba lagi.')
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
    } catch {
      setError('Pertanyaannya belum bisa dibuka lagi. Coba sekali lagi.')
    } finally {
      setSaving(false)
    }
  }

  if (loading || !state) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, color: S.muted, display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, letterSpacing: '.14em' }}>
        SYSTEM ONLINE
      </div>
    )
  }

  if (identified && state.readiness === 'ready') {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Sans", sans-serif', padding: '24px 18px 72px' }}>
        <main style={{ width: '100%', maxWidth: 560, textAlign: 'center' }}>
          <SystemMoment><SystemPulse size={64} /></SystemMoment>
          <SystemMoment delay={180}><div style={{ marginTop: 28 }}><SystemEyebrow>PLAYER IDENTIFIED</SystemEyebrow></div></SystemMoment>
          <SystemMoment delay={310}>
            <h1 style={{ margin: '18px auto 0', maxWidth: 520, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(36px,9vw,54px)', lineHeight: 1, letterSpacing: '-.05em' }}>Oke. Kita mulai dari sini.</h1>
          </SystemMoment>
          <SystemMoment delay={430}>
            <p style={{ margin: '18px auto 0', maxWidth: 430, color: S.muted, fontSize: 14, lineHeight: 1.65 }}>Mulai sekarang, System yang jaga arahnya. Lo tinggal jalanin langkah berikutnya.</p>
          </SystemMoment>
          <SystemMoment delay={560}>
            <button type="button" onClick={onReady} style={{ width: '100%', minHeight: 50, marginTop: 30, border: 0, borderRadius: 13, background: S.amber, color: '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', cursor: 'pointer' }}>MASUK →</button>
          </SystemMoment>
        </main>
      </div>
    )
  }

  if (showIntro) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, display: 'grid', placeItems: 'center', fontFamily: '"IBM Plex Sans", sans-serif', padding: '24px 18px 72px' }}>
        <main style={{ width: '100%', maxWidth: 560, textAlign: 'center' }}>
          <SystemMoment><SystemPulse size={62} /></SystemMoment>
          <SystemMoment delay={160}><div style={{ marginTop: 26 }}><SystemEyebrow>SYSTEM ONLINE</SystemEyebrow></div></SystemMoment>
          <SystemMoment delay={300}>
            <h1 style={{ margin: '18px auto 0', maxWidth: 520, fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(38px,10vw,58px)', lineHeight: .98, letterSpacing: '-.05em' }}>Semua progression punya titik awal.<br />Ini punya lo.</h1>
          </SystemMoment>
          <SystemMoment delay={430}>
            <p style={{ margin: '18px auto 0', maxWidth: 430, color: S.muted, fontSize: 14, lineHeight: 1.65 }}>Nggak perlu punya semua jawaban. Ceritain hidup lo apa adanya.</p>
          </SystemMoment>
          <SystemMoment delay={560}>
            <button type="button" onClick={() => setIntroDismissed(true)} style={{ width: '100%', minHeight: 50, marginTop: 30, border: 0, borderRadius: 13, background: S.amber, color: '#17120a', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', cursor: 'pointer' }}>MULAI →</button>
          </SystemMoment>
        </main>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', padding: '0 18px 76px' }}>
      <main style={{ width: '100%', maxWidth: 680, margin: '0 auto', paddingTop: 28 }}>
        <header style={{ position: 'sticky', top: 0, zIndex: 3, background: 'linear-gradient(180deg,#0c0f14 78%,rgba(12,15,20,0))', padding: '5px 0 19px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {canGoBack && (
                <button type="button" onClick={() => { void goBack() }} aria-label="Kembali ke pertanyaan sebelumnya" style={{ border: 0, padding: '4px 0', background: 'transparent', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, letterSpacing: '.07em', cursor: 'pointer' }}>← KEMBALI</button>
              )}
              <SystemEyebrow>CALIBRATION</SystemEyebrow>
            </div>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: question?.origin === 'adaptive' ? S.gold : S.muted, fontSize: 8.5, fontWeight: 700, letterSpacing: '.08em' }}>
              {questionNumber ? `${questionNumber} / ${totalBasic}` : question?.origin === 'adaptive' ? 'FOLLOW-UP' : `${Math.min(addressedBasic, totalBasic)} / ${totalBasic}`}
            </div>
          </div>
          <div style={{ height: 3, marginTop: 11, borderRadius: 99, overflow: 'hidden', background: '#1b212a' }}>
            <div style={{ width: `${question?.origin === 'adaptive' ? 100 : progress}%`, height: '100%', borderRadius: 99, background: S.amber, boxShadow: '0 0 15px rgba(246,178,75,.3)', transition: 'width 280ms ease' }} />
          </div>
        </header>

        <section data-conversation-thread="onboarding" style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 10 }}>
          {conversationHistory.map(item => (
            <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <ConversationBubble actor="system" compact>{item.prompt}</ConversationBubble>
              <ConversationBubble actor="player" compact>{visiblePlayerAnswer(item)}</ConversationBubble>
            </div>
          ))}

          {question ? (
            <>
              <ConversationBubble actor="system">
                {adaptiveLead && <div style={{ marginBottom: 6, color: S.amber, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, letterSpacing: '.07em' }}>{adaptiveLead}</div>}
                <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(18px,4vw,23px)', fontWeight: 680, lineHeight: 1.35, letterSpacing: '-.02em' }}>{question.prompt}</div>
                {questionHelper && <div style={{ marginTop: 8, color: S.muted, fontSize: 11.8, lineHeight: 1.55 }}>{questionHelper}</div>}
              </ConversationBubble>

              {feedback ? (
                <ConversationStatus>{feedback.replace('✓ ', '')}</ConversationStatus>
              ) : (
                <section data-player-answer-composer style={{ width: 'min(94%, 590px)', alignSelf: 'flex-end' }}>
                  <div style={{ position: 'relative', minHeight: 116, border: `1px solid ${voiceState === 'recording' ? '#4a3a23' : S.line}`, borderRadius: '17px 17px 6px 17px', background: S.panel2, overflow: 'hidden', transition: 'border-color 180ms ease, box-shadow 180ms ease', boxShadow: voiceState === 'recording' ? '0 0 0 1px rgba(246,178,75,.08), 0 16px 42px rgba(0,0,0,.16)' : 'none' }}>
                    {voiceState === 'idle' && (
                      <textarea
                        value={answer}
                        onChange={event => setAnswer(event.target.value)}
                        disabled={systemBusy}
                        placeholder="Balas System…"
                        rows={4}
                        maxLength={5000}
                        autoFocus
                        style={{ width: '100%', minHeight: 116, boxSizing: 'border-box', resize: 'none', border: 0, background: 'transparent', color: S.ink, padding: '14px 58px 14px 14px', outline: 'none', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 14, lineHeight: 1.6 }}
                      />
                    )}
                    <VoiceAnswerRecorder key={question.id} ref={voiceRef} playerId={playerId} questionId={question.id} disabled={systemBusy} textPresent={hasTextAnswer} onStateChange={setVoiceState} />
                  </div>

                  {!voiceBusy && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 9 }}>
                      <button type="button" onClick={() => { void skip() }} disabled={!canSkip} style={{ border: 0, padding: '6px 2px', background: 'transparent', color: canSkip ? S.muted : S.muted2, fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 11.5, cursor: canSkip ? 'pointer' : 'default' }}>Lewati</button>
                      <button type="button" onClick={() => { void submit() }} disabled={!canContinue} style={{ minHeight: 40, border: 0, borderRadius: 11, background: canContinue ? S.amber : '#252b34', color: canContinue ? '#17120a' : S.muted2, padding: '0 16px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.8, fontWeight: 800, letterSpacing: '.08em', cursor: canContinue ? 'pointer' : 'default' }}>{saving ? 'SAVING…' : 'KIRIM →'}</button>
                    </div>
                  )}
                </section>
              )}
            </>
          ) : state.readiness !== 'ready' ? (
            <>
              {jobStatus === 'queued' || jobStatus === 'running' ? (
                <>
                  <ConversationBubble actor="system">
                    <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 19, fontWeight: 680 }}>Oke. Sebentar.</div>
                    <div style={{ marginTop: 7, color: S.muted, fontSize: 12.5 }}>Gue lagi nyambungin semua yang lo ceritain.</div>
                  </ConversationBubble>
                  <ConversationStatus><WaitingCopy elapsedSeconds={waitingSeconds} /></ConversationStatus>
                </>
              ) : answeredThisCycle > 0 ? (
                <>
                  <ConversationBubble actor="system">
                    <div style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 19, fontWeight: 680 }}>{currentCalibrationVersion === 0 ? 'Oke. Gue sambungin dulu semuanya.' : 'Got it. Gue cek lagi.'}</div>
                    <div style={{ marginTop: 7, color: S.muted, fontSize: 12.2 }}>{currentCalibrationVersion === 0 ? 'Kalau masih ada yang kurang, gue bakal nanya. Kalau nggak, kita mulai.' : 'Kalau udah cukup, kita mulai. Kalau belum, gue tanya seperlunya.'}</div>
                  </ConversationBubble>
                  <div style={{ width: 'min(94%, 590px)', alignSelf: 'flex-end', display: 'flex', gap: 9, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    {canGoBack && <button type="button" onClick={() => { void goBack() }} style={{ minHeight: 40, border: `1px solid ${S.line}`, borderRadius: 11, background: 'transparent', color: S.muted, padding: '0 14px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, letterSpacing: '.07em', cursor: 'pointer' }}>← KEMBALI</button>}
                    <button type="button" onClick={() => { void calibrate() }} disabled={systemBusy} style={{ minHeight: 40, border: 0, borderRadius: 11, background: systemBusy ? '#252b34' : S.amber, color: systemBusy ? S.muted2 : '#17120a', padding: '0 16px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.8, fontWeight: 800, letterSpacing: '.08em', cursor: systemBusy ? 'default' : 'pointer' }}>{saving ? 'STARTING…' : currentCalibrationVersion === 0 ? 'LANJUT →' : 'CEK LAGI →'}</button>
                  </div>
                </>
              ) : skippedThisCycle > 0 ? (
                <>
                  <ConversationBubble actor="system">Masih ada satu bagian yang kosong. Balik sebentar; cukup jawab yang lo bisa.</ConversationBubble>
                  <div style={{ alignSelf: 'flex-end' }}><button type="button" onClick={() => { void reviewSkipped() }} disabled={systemBusy} style={{ minHeight: 40, border: 0, borderRadius: 11, background: systemBusy ? '#252b34' : S.amber, color: systemBusy ? S.muted2 : '#17120a', padding: '0 16px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.8, fontWeight: 800, letterSpacing: '.08em', cursor: systemBusy ? 'default' : 'pointer' }}>BALIK KE PERTANYAAN →</button></div>
                </>
              ) : null}
            </>
          ) : null}
        </section>

        {error && <div role="alert" style={{ marginTop: 18, padding: '11px 12px', border: '1px solid #482631', borderRadius: 12, background: '#171116', color: S.red, fontSize: 11.5, lineHeight: 1.5 }}>{error}</div>}
      </main>
    </div>
  )
}
