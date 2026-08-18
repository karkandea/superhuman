'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import SystemInterruptFeed from './system-interrupt-feed'
import { supabase } from '@/lib/supabase'
import { CATEGORY_LABEL, CATEGORY_ORDER, Category, todayStr, toDateStr } from '@/lib/checklist-data'
import {
  getAiInferenceJob,
  getAiInferenceJobForDate,
  requestDailyQuestGeneration,
  type AiInferenceJob,
  type AiInferenceJobStatus,
} from '@/lib/ai/inference-job-service'
import { questKindLabel } from '@/lib/quest-system'

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

interface Item {
  id: string
  anchor: boolean
}

interface GeneratedQuest {
  id: string
  title: string
  category: Category
  kind: 'main' | 'side' | 'maintenance' | 'bonus'
  difficulty: 'easy' | 'medium' | 'hard'
  priority: 1 | 2 | 3 | 4 | 5
  xp: number
  rationale: string
  source: 'ai' | 'system' | 'legacy'
  status: 'pending' | 'completed' | 'partial' | 'skipped' | 'failed' | 'deferred' | 'cancelled' | 'replaced'
  interrupt_id: string | null
  interrupt_reason: string | null
  revision: number
}

function computeStreak(logs: { date: string; checked_ids: string[] }[], anchorIds: string[]) {
  const qualified = new Set(
    logs
      .filter(log => anchorIds.length === 0 ? log.checked_ids.length > 0 : anchorIds.every(id => log.checked_ids.includes(id)))
      .map(log => log.date)
  )

  let streak = 0
  const cursor = new Date()
  if (!qualified.has(toDateStr(cursor))) cursor.setDate(cursor.getDate() - 1)
  while (qualified.has(toDateStr(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export default function DailyQuestPage() {
  const params = useParams()
  const router = useRouter()
  const username = decodeURIComponent(params.username as string)

  const [userId, setUserId] = useState<string | null>(null)
  const [allQuests, setAllQuests] = useState<GeneratedQuest[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [streak, setStreak] = useState(0)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [filter, setFilter] = useState<'semua' | Category>('semua')
  const [generationStatus, setGenerationStatus] = useState<AiInferenceJobStatus | 'idle'>('idle')
  const [generationErrorCode, setGenerationErrorCode] = useState<string | null>(null)
  const [generationErrorMessage, setGenerationErrorMessage] = useState<string | null>(null)

  const checkedRef = useRef<string[]>([])
  const watchedJobRef = useRef<string | null>(null)

  useEffect(() => {
    checkedRef.current = checked
  }, [checked])

  const quests = allQuests.filter(quest => ['pending', 'partial', 'completed'].includes(quest.status))
  const adjustedQuests = allQuests.filter(quest => ['deferred', 'cancelled', 'replaced'].includes(quest.status))
  const questReady = allQuests.length > 0
  const total = quests.length
  const completed = quests.filter(quest => quest.status === 'completed').length
  const pct = total ? Math.round((completed / total) * 100) : 0
  const xpEarned = quests.filter(q => q.status === 'completed').reduce((sum, q) => sum + q.xp, 0)
  const xpTotal = quests.reduce((sum, q) => sum + q.xp, 0)
  const mainQuests = quests.filter(q => q.kind === 'main')
  const mainDone = mainQuests.filter(q => q.status === 'completed').length

  const needsContext = !questReady && generationStatus === 'failed' && generationErrorCode === 'insufficient_context'
  const generationBusy = generationStatus === 'queued' || generationStatus === 'running'
  const systemPaused = !questReady && generationStatus === 'blocked_auth'
  const transportInterrupted = !questReady && generationStatus === 'failed' && ['transient_transport_error', 'provider_rate_limited', 'processing_timeout', 'monitor_failed'].includes(generationErrorCode ?? '')
  const generationFailed = !questReady && generationStatus === 'failed' && !needsContext && !transportInterrupted
  const emptyAfterSuccess = !questReady && generationStatus === 'succeeded'

  const refreshStreak = useCallback(async (uid: string, anchorIds: string[]) => {
    const from60 = toDateStr(new Date(Date.now() - 60 * 864e5))
    const { data } = await supabase
      .from('daily_logs')
      .select('date, checked_ids')
      .eq('user_id', uid)
      .gte('date', from60)
    setStreak(computeStreak(data ?? [], anchorIds))
  }, [])

  const loadGeneratedQuests = useCallback(async (uid: string) => {
    const { data, error } = await supabase
      .from('daily_quests')
      .select('id,title,category,kind,difficulty,priority,xp,rationale,source,status,interrupt_id,interrupt_reason,revision')
      .eq('user_id', uid)
      .eq('quest_date', todayStr())
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)

    const rows = (data ?? []) as GeneratedQuest[]
    setAllQuests(rows)
    const completedIds = rows.filter(row => row.status === 'completed').map(row => row.id)
    checkedRef.current = completedIds
    setChecked(completedIds)
    return rows.length
  }, [])

  const refreshTodayQuests = useCallback(async () => {
    if (!userId) return
    await loadGeneratedQuests(userId)
  }, [loadGeneratedQuests, userId])

  const applyJobState = useCallback((job: AiInferenceJob) => {
    setGenerationStatus(job.status)
    setGenerationErrorCode(job.errorCode ?? null)
    setGenerationErrorMessage(job.errorMessage ?? null)
  }, [])

  const watchGenerationJob = useCallback(async (jobId: string, uid: string) => {
    if (watchedJobRef.current === jobId) return
    watchedJobRef.current = jobId

    try {
      for (let index = 0; index < 120; index += 1) {
        if (index > 0) await delay(1500)
        const current = await getAiInferenceJob(supabase, jobId)
        if (!current) throw new Error('System progression state disappeared')

        applyJobState(current)

        if (current.status === 'succeeded') {
          const count = await loadGeneratedQuests(uid)
          if (count === 0) {
            setGenerationErrorCode('empty_result')
            setGenerationErrorMessage('No Daily Quest was persisted for today.')
          } else {
            setGenerationErrorCode(null)
            setGenerationErrorMessage(null)
          }
          return
        }

        if (current.status === 'failed' || current.status === 'blocked_auth') return
      }

      setGenerationErrorCode('processing_timeout')
      setGenerationErrorMessage('System progression is taking longer than expected.')
    } catch (error) {
      setGenerationStatus('failed')
      setGenerationErrorCode('monitor_failed')
      setGenerationErrorMessage(error instanceof Error ? error.message : 'System failed to monitor progression.')
    } finally {
      if (watchedJobRef.current === jobId) watchedJobRef.current = null
    }
  }, [applyJobState, loadGeneratedQuests])

  const syncAutomaticGeneration = useCallback(async (uid: string) => {
    const job = await getAiInferenceJobForDate(supabase, uid, todayStr())
    if (!job) {
      setGenerationStatus('idle')
      setGenerationErrorCode(null)
      setGenerationErrorMessage(null)
      return
    }

    applyJobState(job)

    if (job.status === 'succeeded') {
      const count = await loadGeneratedQuests(uid)
      if (count === 0) setGenerationErrorCode('empty_result')
      return
    }

    if (job.status === 'failed' || job.status === 'blocked_auth') return
    void watchGenerationJob(job.id, uid)
  }, [applyJobState, loadGeneratedQuests, watchGenerationJob])

  useEffect(() => {
    async function init() {
      const { data: user } = await supabase.from('users').select('id').eq('name', username).single()
      if (!user) {
        router.push('/')
        return
      }

      setUserId(user.id)

      const { data: itemRows } = await supabase
        .from('checklist_items')
        .select('id,anchor')
        .eq('user_id', user.id)
        .eq('is_deleted', false)

      const anchorIds = ((itemRows ?? []) as Item[]).filter(item => item.anchor).map(item => item.id)

      const generatedCount = await loadGeneratedQuests(user.id)
      if (generatedCount === 0) await syncAutomaticGeneration(user.id)
      else {
        const job = await getAiInferenceJobForDate(supabase, user.id, todayStr())
        if (job) {
          applyJobState(job)
          if (job.status === 'queued' || job.status === 'running') void watchGenerationJob(job.id, user.id)
        }
      }

      await refreshStreak(user.id, anchorIds)
      setLoading(false)
    }

    void init().catch(error => {
      setGenerationStatus('failed')
      setGenerationErrorCode('player_state_load_failed')
      setGenerationErrorMessage(error instanceof Error ? error.message : 'System failed to load player state.')
      setLoading(false)
    })
  }, [username, router, refreshStreak, loadGeneratedQuests, syncAutomaticGeneration, applyJobState, watchGenerationJob])

  const toggle = useCallback((id: string) => {
    if (!questReady) return
    const quest = quests.find(item => item.id === id)
    if (!quest || !['pending', 'partial', 'completed'].includes(quest.status)) return

    const before = checkedRef.current
    const willComplete = !before.includes(id)
    const next = willComplete ? [...before, id] : before.filter(value => value !== id)
    checkedRef.current = next
    setChecked(next)
    setStatus('saving')

    void supabase.rpc('set_daily_quest_completion', {
      p_quest_id: id,
      p_completed: willComplete,
    }).then(({ error }) => {
      if (error) {
        checkedRef.current = before
        setChecked(before)
        setStatus('idle')
        return
      }

      setAllQuests(current => current.map(currentQuest => currentQuest.id === id
        ? { ...currentQuest, status: willComplete ? 'completed' : 'pending' }
        : currentQuest
      ))
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 1400)
    })
  }, [questReady, quests])

  const retryGeneration = useCallback(async () => {
    if (!userId || generationBusy) return
    setGenerationErrorCode(null)
    setGenerationErrorMessage(null)

    try {
      const job = await requestDailyQuestGeneration(supabase, todayStr())
      applyJobState(job)

      if (job.status === 'succeeded') {
        await loadGeneratedQuests(userId)
        return
      }

      if (job.status !== 'failed' && job.status !== 'blocked_auth') {
        await watchGenerationJob(job.id, userId)
      }
    } catch (error) {
      setGenerationStatus('failed')
      setGenerationErrorCode('manual_retry_failed')
      setGenerationErrorMessage(error instanceof Error ? error.message : 'System retry failed.')
    }
  }, [applyJobState, generationBusy, loadGeneratedQuests, userId, watchGenerationJob])

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, display: 'grid', placeItems: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace' }}>
        INITIALIZING SYSTEM...
      </div>
    )
  }

  const visibleCategories = filter === 'semua' ? CATEGORY_ORDER : [filter]
  const systemMessage = mainDone === mainQuests.length && mainQuests.length > 0
    ? 'Main Quest complete. Hari ini sudah aman — lanjutkan side quest kalau energi masih ada.'
    : mainQuests.length > 0
      ? `${mainQuests.length - mainDone} Main Quest masih aktif. Selesaikan ini sebelum mengejar bonus.`
      : adjustedQuests.length > 0 && quests.length === 0
        ? 'System sudah menyesuaikan plan hari ini. Tidak ada quest aktif yang perlu dipaksakan sekarang.'
        : 'Quest hari ini aktif. Hasil eksekusinya akan dipakai System untuk progression berikutnya.'

  return (
    <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 72 }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '30px 0 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, color: S.amber, letterSpacing: '.18em' }}>SYSTEM ONLINE</div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: S.muted, marginTop: 5 }}>
                PLAYER · {username.toUpperCase()}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Link href={`/${encodeURIComponent(username)}/vault`} style={{ color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, textDecoration: 'none', letterSpacing: '.08em' }}>
                LIFE VAULT →
              </Link>
              <Link href={`/${encodeURIComponent(username)}/history`} style={{ color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, textDecoration: 'none', letterSpacing: '.08em' }}>
                HISTORY →
              </Link>
            </div>
          </div>

          <div style={{ marginTop: 26 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 11 }}>
              {new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
            <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(30px,8vw,42px)', lineHeight: 1, letterSpacing: '-.04em', margin: '8px 0 0' }}>
              Daily Quest
            </h1>
            <p style={{ color: S.muted, fontSize: 13, lineHeight: 1.55, margin: '10px 0 0', maxWidth: 500 }}>
              {questReady
                ? 'Fokus hari ini stabil by default. Kalau situasi penting berubah, System akan melakukan interrupt secara eksplisit — bukan reshuffle diam-diam.'
                : 'Daily Quest dibuat otomatis dari apa yang System pahami tentang hidup, tujuan, dan hambatan lo.'}
            </p>
          </div>

          {!questReady && (
            <SystemEmptyState
              username={username}
              generationStatus={generationStatus}
              needsContext={needsContext}
              generationFailed={generationFailed || emptyAfterSuccess}
              transportInterrupted={transportInterrupted}
              systemPaused={systemPaused}
              onRetry={retryGeneration}
            />
          )}

          {questReady && generationBusy && (
            <div style={{ marginTop: 18, border: `1px solid ${S.line}`, borderRadius: 12, padding: '10px 12px', background: S.panel2 }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9, letterSpacing: '.12em' }}>SYSTEM PROCESSING NEW CONTEXT</div>
              <div style={{ marginTop: 4, color: S.muted, fontSize: 11, lineHeight: 1.45 }}>Quest sekarang tetap aktif selama System menilai apakah update terbaru cukup material untuk mengubah prioritas hari ini.</div>
            </div>
          )}

          <SystemInterruptFeed playerId={userId} date={todayStr()} onApplied={refreshTodayQuests} />

          {questReady && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 22 }}>
                <Stat value={`${pct}%`} label="PROGRESS" />
                <Stat value={`${xpEarned}/${xpTotal}`} label="XP" />
                <Stat value={`${streak}`} label="STREAK" />
              </div>

              <div style={{ marginTop: 12, height: 6, background: '#1c222c', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: `linear-gradient(90deg,${S.amber},${S.gold})`, transition: 'width 400ms ease' }} />
              </div>

              <div style={{ marginTop: 14, background: S.panel2, border: `1px solid ${S.line}`, borderRadius: 14, padding: '13px 14px' }}>
                <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9, letterSpacing: '.12em' }}>SYSTEM ASSESSMENT</div>
                <div style={{ color: S.ink, fontSize: 12.5, lineHeight: 1.5, marginTop: 6 }}>{systemMessage}</div>
              </div>

              <div style={{ height: 14, marginTop: 8, fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, color: status === 'saved' ? S.amber : S.muted, opacity: status === 'idle' ? 0 : 1 }}>
                {status === 'saving' ? 'SYNCING...' : status === 'saved' ? '✓ QUEST STATE SAVED' : ''}
              </div>
            </>
          )}
        </header>

        {quests.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '2px 0 14px' }}>
              {(['semua', ...CATEGORY_ORDER] as const).map(category => (
                <button
                  key={category}
                  onClick={() => setFilter(category)}
                  style={{
                    flexShrink: 0,
                    border: filter === category ? 'none' : `1px solid ${S.line}`,
                    background: filter === category ? S.amber : 'transparent',
                    color: filter === category ? S.bg : S.muted,
                    borderRadius: 99,
                    padding: '8px 13px',
                    fontFamily: '"IBM Plex Mono", monospace',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {category === 'semua' ? 'SEMUA' : CATEGORY_LABEL[category].toUpperCase()}
                </button>
              ))}
            </div>

            <main>
              {visibleCategories.map(category => {
                const categoryQuests = quests.filter(quest => quest.category === category)
                if (categoryQuests.length === 0) return null

                return (
                  <section key={category} style={{ marginTop: 16 }}>
                    <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, color: S.muted, letterSpacing: '.12em', margin: '0 2px 8px' }}>
                      {CATEGORY_LABEL[category].toUpperCase()}
                    </div>
                    <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, overflow: 'hidden' }}>
                      {categoryQuests.map((quest, index) => {
                        const done = checked.includes(quest.id)
                        return (
                          <div
                            key={quest.id}
                            onClick={() => toggle(quest.id)}
                            role="checkbox"
                            aria-checked={done}
                            tabIndex={0}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                toggle(quest.id)
                              }
                            }}
                            style={{
                              display: 'flex', gap: 13, padding: '15px 16px',
                              borderTop: index === 0 ? 'none' : `1px solid ${S.line}`,
                              cursor: 'pointer', background: done ? 'rgba(246,178,75,.035)' : 'transparent',
                            }}
                          >
                            <span style={{
                              width: 22, height: 22, flexShrink: 0, borderRadius: 7,
                              border: done ? 'none' : '1.5px solid #39414e', display: 'grid', placeItems: 'center',
                              background: done ? `linear-gradient(135deg,${S.amber},${S.gold})` : 'transparent',
                              boxShadow: done ? '0 0 14px rgba(246,178,75,.4)' : 'none', marginTop: 2,
                            }}>
                              {done ? '✓' : ''}
                            </span>

                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: quest.kind === 'main' ? S.amber : S.muted, letterSpacing: '.1em' }}>
                                  {questKindLabel[quest.kind]}
                                </span>
                                {quest.interrupt_id && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.amber, letterSpacing: '.08em' }}>INTERRUPT</span>}
                                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: S.gold }}>+{quest.xp} XP</span>
                              </div>
                              <div style={{ marginTop: 5, fontSize: 14.5, lineHeight: 1.45, color: done ? S.muted : S.ink, textDecoration: done ? 'line-through' : 'none' }}>
                                {quest.title}
                              </div>
                              {quest.rationale && (
                                <div style={{ marginTop: 6, color: S.muted, fontSize: 11, lineHeight: 1.45 }}>{quest.rationale}</div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </main>
          </>
        )}

        {adjustedQuests.length > 0 && (
          <section style={{ marginTop: 28 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 9, letterSpacing: '.13em', marginBottom: 8 }}>ADJUSTED TODAY</div>
            <div style={{ border: `1px solid ${S.line}`, borderRadius: 14, background: S.panel2, overflow: 'hidden' }}>
              {adjustedQuests.map((quest, index) => (
                <div key={quest.id} style={{ padding: '11px 13px', borderTop: index ? `1px solid ${S.line}` : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                    <div style={{ color: S.muted, fontSize: 12.5, textDecoration: quest.status === 'replaced' ? 'line-through' : 'none' }}>{quest.title}</div>
                    <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8, letterSpacing: '.08em' }}>{quest.status.toUpperCase()}</div>
                  </div>
                  {quest.interrupt_reason && <div style={{ marginTop: 4, color: '#626c79', fontSize: 10.5, lineHeight: 1.4 }}>{quest.interrupt_reason}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        <footer style={{ padding: '32px 0 10px', textAlign: 'center' }}>
          <div style={{ color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, lineHeight: 1.6 }}>
            QUEST AUTHORING IS SYSTEM-OWNED<br />
            {questReady ? 'stable by default · explicit interrupts when material context changes' : 'add life context and let the System decide what matters next'}
          </div>
          <Link href="/" style={{ display: 'inline-block', marginTop: 16, color: S.muted, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 10 }}>
            ← SWITCH PLAYER
          </Link>
          {generationErrorMessage && process.env.NODE_ENV !== 'production' && (
            <div style={{ marginTop: 12, color: S.red, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>
              DEBUG · {generationErrorCode ?? 'unknown'} · {generationErrorMessage}
            </div>
          )}
        </footer>
      </div>
    </div>
  )
}

function SystemEmptyState({
  username,
  generationStatus,
  needsContext,
  generationFailed,
  transportInterrupted,
  systemPaused,
  onRetry,
}: {
  username: string
  generationStatus: AiInferenceJobStatus | 'idle'
  needsContext: boolean
  generationFailed: boolean
  transportInterrupted: boolean
  systemPaused: boolean
  onRetry: () => void
}) {
  const queued = generationStatus === 'queued'
  const running = generationStatus === 'running'

  let eyebrow = 'PLAYER CONTEXT REQUIRED'
  let title = 'SYSTEM NEEDS TO KNOW YOU FIRST'
  let body = 'Ceritain apa yang sedang lo kejar, masalah yang lagi lo hadapi, atau perubahan penting yang baru terjadi. System akan memakai konteks itu untuk menentukan quest yang relevan.'

  if (queued) {
    eyebrow = 'UPDATE RECEIVED'
    title = 'SYSTEM IS PREPARING YOUR PROGRESSION'
    body = 'Konteks lo sudah masuk. System akan memprosesnya dan Daily Quest akan muncul otomatis setelah progression siap.'
  } else if (running) {
    eyebrow = 'UNDERSTANDING PLAYER'
    title = 'SYSTEM IS ANALYZING YOUR CONTEXT'
    body = 'System sedang menghubungkan update terbaru dengan tujuan, hambatan, dan progression lo. Daily Quest akan muncul otomatis setelah selesai.'
  } else if (systemPaused) {
    eyebrow = 'SYSTEM TEMPORARILY PAUSED'
    title = 'YOUR CONTEXT IS SAFE'
    body = 'System belum bisa melanjutkan processing saat ini. Update lo tetap tersimpan dan tidak perlu dimasukkan ulang.'
  } else if (transportInterrupted) {
    eyebrow = 'SYSTEM TEMPORARILY INTERRUPTED'
    title = 'YOUR CONTEXT IS SAFE'
    body = 'Koneksi ke reasoning engine sempat terinterupsi. Tidak ada context yang hilang. Tunggu sebentar lalu coba lagi — lo tidak perlu menulis ulang atau menambah context.'
  } else if (generationFailed) {
    eyebrow = 'SYSTEM COULD NOT FINISH'
    title = 'YOUR CONTEXT IS STILL SAFE'
    body = 'System belum berhasil menyelesaikan progression kali ini. Context lo tetap tersimpan; coba proses ulang tanpa memasukkan data yang sama lagi.'
  } else if (needsContext) {
    eyebrow = 'PLAYER CONTEXT REQUIRED'
  }

  const canRetry = generationFailed || transportInterrupted

  return (
    <div style={{ marginTop: 20, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 18, padding: '18px 16px' }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: S.amber, letterSpacing: '.14em' }}>{eyebrow}</div>
      <div style={{ marginTop: 8, fontFamily: '"Space Grotesk", sans-serif', fontSize: 19, fontWeight: 700, lineHeight: 1.2 }}>{title}</div>
      <div style={{ marginTop: 9, color: S.muted, fontSize: 12.5, lineHeight: 1.6 }}>{body}</div>

      {needsContext && !queued && !running && !systemPaused && (
        <Link
          href={`/${encodeURIComponent(username)}/vault`}
          style={{
            display: 'block', marginTop: 16, borderRadius: 10, padding: '12px 16px', textAlign: 'center',
            background: S.amber, color: S.bg, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace',
            fontWeight: 700, fontSize: 11, letterSpacing: '.08em',
          }}
        >
          ADD TO LIFE VAULT →
        </Link>
      )}

      {canRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            width: '100%', marginTop: 16, border: 'none', borderRadius: 10, padding: '12px 16px', background: S.amber, color: S.bg,
            fontFamily: '"IBM Plex Mono", monospace', fontWeight: 700, fontSize: 11, letterSpacing: '.08em', cursor: 'pointer',
          }}
        >
          TRY AGAIN
        </button>
      )}
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 14, padding: '12px 10px' }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 20, fontWeight: 700, color: S.gold }}>{value}</div>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.muted, letterSpacing: '.1em', marginTop: 3 }}>{label}</div>
    </div>
  )
}
