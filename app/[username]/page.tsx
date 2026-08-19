'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import DailyContextCheckin from './daily-context-checkin'
import SystemFreshnessCard from './system-freshness-card'
import SystemInterruptFeed from './system-interrupt-feed'
import UpdateSystemComposer from './update-system-composer'
import { supabase } from '@/lib/supabase'
import { CATEGORY_LABEL, CATEGORY_ORDER, Category, todayStr, toDateStr } from '@/lib/checklist-data'
import { getDailyContextForDate } from '@/lib/daily-context-service'
import type { DailyContextSnapshot } from '@/lib/daily-context'
import { getDailyPlanState, type DailyPlanState } from '@/lib/daily-plan-service'
import {
  getAiInferenceJob,
  getAiInferenceJobForDate,
  requestDailyQuestGeneration,
  type AiInferenceJob,
  type AiInferenceJobStatus,
} from '@/lib/ai/inference-job-service'
import { questKindLabel } from '@/lib/quest-system'
import type { QuestExecutionContract, QuestStrategicChain } from '@/lib/progression-intelligence'

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35', lineStrong: '#303946',
  ink: '#ECEAE3', muted: '#7e8795', muted2: '#596270', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

interface Item { id: string; anchor: boolean }
type QuestOutcome = 'completed' | 'partial' | 'skipped' | 'failed'

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
  progression_target_id: string | null
  candidate_id: string | null
  strategic_chain: QuestStrategicChain | Record<string, never>
  execution_contract: QuestExecutionContract | Record<string, never>
}

function computeStreak(logs: { date: string; checked_ids: string[] }[], anchorIds: string[]) {
  const qualified = new Set(logs
    .filter(log => anchorIds.length === 0 ? log.checked_ids.length > 0 : anchorIds.every(id => log.checked_ids.includes(id)))
    .map(log => log.date))
  let streak = 0
  const cursor = new Date()
  if (!qualified.has(toDateStr(cursor))) cursor.setDate(cursor.getDate() - 1)
  while (qualified.has(toDateStr(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function strategicWhy(quest: GeneratedQuest) {
  return hasText(quest.strategic_chain?.causalReason) ? quest.strategic_chain.causalReason.trim() : quest.rationale
}

function doneWhen(quest: GeneratedQuest) {
  return hasText(quest.execution_contract?.completionCondition) ? quest.execution_contract.completionCondition.trim() : null
}

function questDose(quest: GeneratedQuest) {
  return hasText(quest.execution_contract?.dose) ? quest.execution_contract.dose.trim() : null
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export default function DailyQuestPage() {
  const params = useParams()
  const router = useRouter()
  const username = decodeURIComponent(params.username as string)
  const [userId, setUserId] = useState<string | null>(null)
  const [dailyContext, setDailyContext] = useState<DailyContextSnapshot | null>(null)
  const [dailyPlan, setDailyPlan] = useState<DailyPlanState | null>(null)
  const [allQuests, setAllQuests] = useState<GeneratedQuest[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [streak, setStreak] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [generationStatus, setGenerationStatus] = useState<AiInferenceJobStatus | 'idle'>('idle')
  const [generationErrorCode, setGenerationErrorCode] = useState<string | null>(null)
  const [generationErrorMessage, setGenerationErrorMessage] = useState<string | null>(null)
  const [freshnessToken, setFreshnessToken] = useState(0)
  const [mutatingQuestIds, setMutatingQuestIds] = useState<Set<string>>(new Set())
  const [resultOpenQuestId, setResultOpenQuestId] = useState<string | null>(null)
  const [resultNote, setResultNote] = useState('')
  const checkedRef = useRef<string[]>([])
  const watchedJobRef = useRef<string | null>(null)

  useEffect(() => { checkedRef.current = checked }, [checked])

  const quests = allQuests.filter(quest => ['pending', 'partial', 'completed'].includes(quest.status))
  const adjustedQuests = allQuests.filter(quest => ['deferred', 'cancelled', 'replaced', 'skipped', 'failed'].includes(quest.status))
  const questReady = allQuests.length > 0
  const dailyPlanReady = questReady || Boolean(dailyPlan?.finalized)
  const total = quests.length
  const completed = quests.filter(quest => quest.status === 'completed').length
  const pct = total ? Math.round((completed / total) * 100) : 0
  const xpEarned = quests.filter(quest => quest.status === 'completed').reduce((sum, quest) => sum + quest.xp, 0)
  const xpTotal = quests.reduce((sum, quest) => sum + quest.xp, 0)
  const mainQuests = quests.filter(quest => quest.kind === 'main')
  const mainDone = mainQuests.filter(quest => quest.status === 'completed').length
  const generationBusy = generationStatus === 'queued' || generationStatus === 'running'
  const needsPlayerContext = !dailyPlanReady && generationStatus === 'failed' && generationErrorCode === 'insufficient_context'
  const systemPaused = !dailyPlanReady && generationStatus === 'blocked_auth'
  const transportInterrupted = !dailyPlanReady && generationStatus === 'failed' && ['transient_transport_error', 'provider_rate_limited', 'processing_timeout', 'monitor_failed'].includes(generationErrorCode ?? '')
  const generationFailed = !dailyPlanReady && generationStatus === 'failed' && !needsPlayerContext && !transportInterrupted
  const emptyAfterSuccess = !dailyPlanReady && Boolean(dailyContext) && generationStatus === 'succeeded'

  const refreshStreak = useCallback(async (uid: string, anchorIds: string[]) => {
    const from60 = toDateStr(new Date(Date.now() - 60 * 864e5))
    const { data } = await supabase.from('daily_logs').select('date, checked_ids').eq('user_id', uid).gte('date', from60)
    setStreak(computeStreak(data ?? [], anchorIds))
  }, [])

  const loadDailyPlan = useCallback(async (uid: string) => {
    const plan = await getDailyPlanState(supabase, uid, todayStr())
    setDailyPlan(plan)
    return plan
  }, [])

  const loadGeneratedQuests = useCallback(async (uid: string) => {
    const { data, error } = await supabase
      .from('daily_quests')
      .select('id,title,category,kind,difficulty,priority,xp,rationale,source,status,interrupt_id,interrupt_reason,revision,progression_target_id,candidate_id,strategic_chain,execution_contract')
      .eq('user_id', uid)
      .eq('quest_date', todayStr())
      .order('priority', { ascending: false })
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
    await Promise.all([loadGeneratedQuests(userId), loadDailyPlan(userId)])
  }, [loadDailyPlan, loadGeneratedQuests, userId])

  const applyJobState = useCallback((job: AiInferenceJob) => {
    setGenerationStatus(job.status)
    setGenerationErrorCode(job.errorCode ?? null)
    setGenerationErrorMessage(job.errorMessage ?? null)
  }, [])

  const settleSuccessfulJob = useCallback(async (uid: string) => {
    const [count, plan] = await Promise.all([loadGeneratedQuests(uid), loadDailyPlan(uid)])
    if (count === 0 && !plan.finalized) {
      const context = await getDailyContextForDate(supabase, uid, todayStr())
      setDailyContext(context)
      if (context) {
        setGenerationErrorCode('empty_result')
        setGenerationErrorMessage('System finished without finalizing today’s plan.')
      }
      return
    }
    setGenerationErrorCode(null)
    setGenerationErrorMessage(null)
  }, [loadDailyPlan, loadGeneratedQuests])

  const watchGenerationJob = useCallback(async (jobId: string, uid: string) => {
    if (watchedJobRef.current === jobId) return
    watchedJobRef.current = jobId
    try {
      for (let index = 0; index < 120; index += 1) {
        if (index > 0) await delay(1500)
        const current = await getAiInferenceJob(supabase, jobId)
        if (!current) throw new Error('System progression state disappeared')
        applyJobState(current)
        setFreshnessToken(token => token + 1)
        if (current.status === 'succeeded') {
          await settleSuccessfulJob(uid)
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
  }, [applyJobState, settleSuccessfulJob])

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
      await settleSuccessfulJob(uid)
      return
    }
    if (job.status !== 'failed' && job.status !== 'blocked_auth') void watchGenerationJob(job.id, uid)
  }, [applyJobState, settleSuccessfulJob, watchGenerationJob])

  const startGenerationAfterCheckin = useCallback(async (uid: string) => {
    setGenerationErrorCode(null)
    setGenerationErrorMessage(null)
    const job = await requestDailyQuestGeneration(supabase, todayStr())
    applyJobState(job)
    if (job.status === 'succeeded') {
      await settleSuccessfulJob(uid)
      return
    }
    if (job.status !== 'failed' && job.status !== 'blocked_auth') void watchGenerationJob(job.id, uid)
  }, [applyJobState, settleSuccessfulJob, watchGenerationJob])

  useEffect(() => {
    let cancelled = false
    async function init() {
      const { data: user } = await supabase.from('users').select('id').eq('name', username).single()
      if (!user || cancelled) {
        if (!cancelled) router.push('/')
        return
      }
      setUserId(user.id)
      const { data: itemRows } = await supabase.from('checklist_items').select('id,anchor').eq('user_id', user.id).eq('is_deleted', false)
      const anchorIds = ((itemRows ?? []) as Item[]).filter(item => item.anchor).map(item => item.id)
      const [generatedCount, plan, context] = await Promise.all([
        loadGeneratedQuests(user.id),
        loadDailyPlan(user.id),
        getDailyContextForDate(supabase, user.id, todayStr()),
      ])
      if (!cancelled) setDailyContext(context)

      if (generatedCount === 0 && !plan.finalized) {
        if (context) {
          const job = await getAiInferenceJobForDate(supabase, user.id, todayStr())
          if (!job || job.status === 'succeeded') await startGenerationAfterCheckin(user.id)
          else await syncAutomaticGeneration(user.id)
        } else {
          setGenerationStatus('idle')
          setGenerationErrorCode(null)
          setGenerationErrorMessage(null)
        }
      } else {
        const job = await getAiInferenceJobForDate(supabase, user.id, todayStr())
        if (job) {
          applyJobState(job)
          if (job.status === 'queued' || job.status === 'running') void watchGenerationJob(job.id, user.id)
        }
      }
      await refreshStreak(user.id, anchorIds)
      if (!cancelled) setLoading(false)
    }
    void init().catch(error => {
      if (cancelled) return
      setGenerationStatus('failed')
      setGenerationErrorCode('player_state_load_failed')
      setGenerationErrorMessage(error instanceof Error ? error.message : 'System failed to load player state.')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [username, router, refreshStreak, loadGeneratedQuests, loadDailyPlan, startGenerationAfterCheckin, syncAutomaticGeneration, applyJobState, watchGenerationJob])

  async function persistQuestCompletion(id: string, before: string[], willComplete: boolean) {
    try {
      const { error } = await supabase.rpc('set_daily_quest_completion', { p_quest_id: id, p_completed: willComplete })
      if (error) {
        checkedRef.current = before
        setChecked(before)
        setSaveStatus('failed')
        window.setTimeout(() => setSaveStatus('idle'), 2200)
        return
      }
      setAllQuests(current => current.map(quest => quest.id === id ? { ...quest, status: willComplete ? 'completed' : 'pending' } : quest))
      setSaveStatus('saved')
      setFreshnessToken(token => token + 1)
      if (userId) void syncAutomaticGeneration(userId)
      window.setTimeout(() => setSaveStatus('idle'), 1400)
    } finally {
      setMutatingQuestIds(current => {
        const nextSet = new Set(current)
        nextSet.delete(id)
        return nextSet
      })
    }
  }

  function toggle(id: string) {
    if (!questReady || mutatingQuestIds.has(id)) return
    const before = checkedRef.current
    const willComplete = !before.includes(id)
    const next = willComplete ? [...before, id] : before.filter(value => value !== id)
    checkedRef.current = next
    setChecked(next)
    setSaveStatus('saving')
    setMutatingQuestIds(current => new Set(current).add(id))
    void persistQuestCompletion(id, before, willComplete)
  }

  async function recordQuestResult(id: string, outcome: Exclude<QuestOutcome, 'completed'>, note: string) {
    if (mutatingQuestIds.has(id)) return
    setSaveStatus('saving')
    setMutatingQuestIds(current => new Set(current).add(id))
    try {
      const { error } = await supabase.rpc('record_daily_quest_result', {
        p_quest_id: id,
        p_outcome: outcome,
        p_note: note.trim() || null,
      })
      if (error) throw new Error(error.message)
      checkedRef.current = checkedRef.current.filter(value => value !== id)
      setChecked(checkedRef.current)
      setAllQuests(current => current.map(quest => quest.id === id ? { ...quest, status: outcome } : quest))
      setResultOpenQuestId(null)
      setResultNote('')
      setSaveStatus('saved')
      setFreshnessToken(token => token + 1)
      if (userId) void syncAutomaticGeneration(userId)
      window.setTimeout(() => setSaveStatus('idle'), 1400)
    } catch {
      setSaveStatus('failed')
      window.setTimeout(() => setSaveStatus('idle'), 2200)
    } finally {
      setMutatingQuestIds(current => {
        const nextSet = new Set(current)
        nextSet.delete(id)
        return nextSet
      })
    }
  }

  async function retryGeneration() {
    if (!userId || generationBusy || (!dailyContext && !dailyPlanReady)) return
    try {
      await startGenerationAfterCheckin(userId)
    } catch (error) {
      setGenerationStatus('failed')
      setGenerationErrorCode('manual_retry_failed')
      setGenerationErrorMessage(error instanceof Error ? error.message : 'System retry failed.')
    }
  }

  async function handleDailyContextConfirmed(context: DailyContextSnapshot) {
    setDailyContext(context)
    if (!userId) return
    try {
      await startGenerationAfterCheckin(userId)
    } catch (error) {
      setGenerationStatus('failed')
      setGenerationErrorCode('daily_context_generation_failed')
      setGenerationErrorMessage(error instanceof Error ? error.message : 'System could not start today progression.')
    }
  }

  async function handleSystemUpdateSaved() {
    setFreshnessToken(token => token + 1)
    if (userId) await syncAutomaticGeneration(userId)
  }

  if (loading) return <div style={{ minHeight: '100dvh', background: S.bg, display: 'grid', placeItems: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace' }}>INITIALIZING SYSTEM…</div>

  const systemMessage = mainDone === mainQuests.length && mainQuests.length > 0
    ? 'Main Quest complete. Today is already safe — side quests are optional from here.'
    : mainQuests.length > 0
      ? `${mainQuests.length - mainDone} Main Quest${mainQuests.length - mainDone === 1 ? '' : 's'} still active. Finish the important work before chasing bonus XP.`
      : dailyPlan?.noQuest && quests.length === 0
        ? 'The System intentionally added no quest. Intelligence includes knowing when more intervention would only add burden.'
        : adjustedQuests.length > 0 && quests.length === 0
          ? 'System adjusted today. There is no active quest that needs to be forced right now.'
          : 'Today’s quests are active. Execution feeds the next progression cycle.'

  return (
    <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif', paddingBottom: 72 }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '26px 0 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, color: S.amber, fontWeight: 700, letterSpacing: '.18em' }}>SYSTEM ONLINE</div>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 10.5, color: S.muted, marginTop: 4 }}>PLAYER · {username.toUpperCase()}</div>
            </div>
            <nav aria-label="Player navigation" style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <Link href={`/${encodeURIComponent(username)}/vault`} style={{ color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, textDecoration: 'none', letterSpacing: '.07em' }}>LIFE VAULT</Link>
              <Link href={`/${encodeURIComponent(username)}/history`} style={{ color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, textDecoration: 'none', letterSpacing: '.07em' }}>PROGRESSION</Link>
            </nav>
          </div>

          <div style={{ marginTop: 24 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 10.5 }}>{new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
            <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(32px,8vw,44px)', lineHeight: .98, letterSpacing: '-.045em', margin: '7px 0 0' }}>Daily Quest</h1>
            <p style={{ color: S.muted, fontSize: 12.5, lineHeight: 1.55, margin: '9px 0 0', maxWidth: 520 }}>
              {dailyPlanReady
                ? 'The System chose what deserves attention today from your progression strategy, response history, and real daily capacity. The plan stays stable by default.'
                : dailyContext
                  ? 'Check-in received. The System is choosing today’s progression target before it creates any quest.'
                  : 'One quick check-in fills the blind spot the System cannot observe before it chooses today’s progression target.'}
            </p>
          </div>

          {questReady && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 9, marginTop: 19 }}>
                <Stat value={`${pct}%`} label="PROGRESS" />
                <Stat value={`${xpEarned}/${xpTotal}`} label="XP" />
                <Stat value={`${streak}`} label="STREAK" />
              </div>
              <div style={{ marginTop: 10, height: 5, background: '#1c222c', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: `linear-gradient(90deg,${S.amber},${S.gold})`, transition: 'width 400ms ease' }} />
              </div>
            </>
          )}

          {dailyPlanReady && (
            <div style={{ marginTop: 12, background: S.panel2, border: `1px solid ${S.line}`, borderRadius: 13, padding: '11px 12px' }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8.5, letterSpacing: '.12em' }}>{dailyPlan?.progressionTargetSummary ? 'TODAY’S PROGRESSION TARGET' : 'SYSTEM ASSESSMENT'}</div>
              {dailyPlan?.progressionTargetSummary && <div style={{ color: S.gold, fontSize: 12.5, lineHeight: 1.5, marginTop: 5 }}>{dailyPlan.progressionTargetSummary}</div>}
              <div style={{ color: S.ink, fontSize: 12, lineHeight: 1.5, marginTop: dailyPlan?.progressionTargetSummary ? 7 : 5 }}>{systemMessage}</div>
            </div>
          )}

          {dailyPlanReady && (
            <div style={{ marginTop: 13 }}>
              <SystemFreshnessCard
                playerId={userId}
                date={todayStr()}
                refreshToken={freshnessToken}
                compact
                onSettled={refreshTodayQuests}
              />
            </div>
          )}

          {dailyPlanReady && <SystemInterruptFeed playerId={userId} date={todayStr()} onApplied={refreshTodayQuests} />}

          <div aria-live="polite" style={{ height: 15, marginTop: 7, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: saveStatus === 'failed' ? S.red : saveStatus === 'saved' ? S.amber : S.muted, opacity: saveStatus === 'idle' ? 0 : 1 }}>
            {saveStatus === 'saving' ? 'SYNCING QUEST…' : saveStatus === 'saved' ? '✓ QUEST RESULT SAVED · SYSTEM LEARNING QUEUED' : saveStatus === 'failed' ? 'QUEST UPDATE FAILED · NOTHING CHANGED' : ''}
          </div>
        </header>

        {!dailyPlanReady && (
          <div style={{ marginTop: 4 }}>
            <DailyContextCheckin
              date={todayStr()}
              context={dailyContext}
              generationBusy={generationBusy}
              onConfirmed={handleDailyContextConfirmed}
            />
          </div>
        )}

        {!dailyPlanReady && dailyContext && (
          <SystemEmptyState
            generationStatus={generationStatus}
            needsPlayerContext={needsPlayerContext}
            generationFailed={generationFailed || emptyAfterSuccess}
            transportInterrupted={transportInterrupted}
            systemPaused={systemPaused}
            onRetry={() => { void retryGeneration() }}
          />
        )}

        {!dailyPlanReady && dailyContext && needsPlayerContext && (
          <div style={{ marginTop: 16 }}>
            <UpdateSystemComposer variant="compact" onSaved={handleSystemUpdateSaved} />
          </div>
        )}

        {dailyPlan?.noQuest && quests.length === 0 && (
          <section style={{ marginTop: 7, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 17, padding: '17px 15px' }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.amber, letterSpacing: '.14em' }}>SYSTEM DECISION · NO QUEST NEEDED</div>
            <div style={{ marginTop: 7, fontFamily: '"Space Grotesk", sans-serif', fontSize: 18, fontWeight: 700, lineHeight: 1.2 }}>Nothing else deserves a slot today.</div>
            <div style={{ marginTop: 8, color: S.muted, fontSize: 12, lineHeight: 1.55 }}>{dailyPlan.noQuestReason ?? 'The System decided another intervention would add more burden than useful progression today.'}</div>
            <a href="#update-system" style={{ display: 'inline-block', marginTop: 12, color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, textDecoration: 'none', letterSpacing: '.06em' }}>UPDATE SYSTEM IF LIFE CHANGES ↓</a>
          </section>
        )}

        {quests.length > 0 && (
          <main style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
              <div>
                <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9, letterSpacing: '.14em' }}>TODAY’S PLAN</div>
                <h2 style={{ margin: '5px 0 0', fontFamily: '"Space Grotesk", sans-serif', fontSize: 20, letterSpacing: '-.025em' }}>{completed}/{total} complete</h2>
              </div>
              <a href="#update-system" style={{ color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, textDecoration: 'none', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>UPDATE SYSTEM ↓</a>
            </div>

            {CATEGORY_ORDER.map(category => {
              const categoryQuests = quests.filter(quest => quest.category === category)
              if (!categoryQuests.length) return null
              return (
                <section key={category} style={{ marginTop: 17 }}>
                  <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: S.muted, letterSpacing: '.12em', margin: '0 2px 7px' }}>{CATEGORY_LABEL[category].toUpperCase()}</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {categoryQuests.map((quest) => {
                      const done = checked.includes(quest.id)
                      const mutating = mutatingQuestIds.has(quest.id)
                      const why = strategicWhy(quest)
                      const doneCondition = doneWhen(quest)
                      const dose = questDose(quest)
                      const resultOpen = resultOpenQuestId === quest.id
                      return (
                        <div key={quest.id} style={{ border: `1px solid ${quest.interrupt_id ? '#443a24' : S.line}`, borderRadius: 15, background: quest.interrupt_id ? 'linear-gradient(135deg,#17150f,#13171f)' : done ? 'rgba(246,178,75,.035)' : S.panel, overflow: 'hidden', opacity: mutating ? .65 : 1 }}>
                          <button
                            type="button"
                            onClick={() => toggle(quest.id)}
                            disabled={mutating}
                            aria-pressed={done}
                            aria-label={`${done ? 'Mark incomplete' : 'Complete'}: ${quest.title}`}
                            style={{ width: '100%', display: 'flex', gap: 13, textAlign: 'left', padding: '14px 14px 11px', border: 'none', cursor: mutating ? 'default' : 'pointer', background: 'transparent', color: 'inherit' }}
                          >
                            <span aria-hidden="true" style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 7, border: done ? 'none' : '1.5px solid #39414e', display: 'grid', placeItems: 'center', background: done ? `linear-gradient(135deg,${S.amber},${S.gold})` : 'transparent', boxShadow: done ? '0 0 14px rgba(246,178,75,.35)' : 'none', marginTop: 1, color: S.bg, fontSize: 13, fontWeight: 800 }}>{done ? '✓' : ''}</span>
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <span style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: quest.kind === 'main' ? S.amber : S.muted, letterSpacing: '.09em' }}>{questKindLabel[quest.kind]}</span>
                                {quest.interrupt_id && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.gold, letterSpacing: '.08em' }}>NEW · INTERRUPT</span>}
                                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.gold }}>+{quest.xp} XP</span>
                                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: done ? S.amber : S.muted2 }}>{done ? 'COMPLETED' : quest.status === 'partial' ? 'PARTIAL' : 'ACTIVE'}</span>
                              </span>
                              <span style={{ display: 'block', marginTop: 5, fontSize: 14, lineHeight: 1.42, color: done ? S.muted : S.ink, textDecoration: done ? 'line-through' : 'none' }}>{quest.title}</span>
                            </span>
                          </button>

                          {(why || doneCondition || dose) && (
                            <div style={{ padding: '0 14px 11px 49px', display: 'grid', gap: 5 }}>
                              {why && <div style={{ color: S.muted, fontSize: 10.5, lineHeight: 1.45 }}><span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.amber, letterSpacing: '.07em' }}>WHY · </span>{why}</div>}
                              {doneCondition && <div style={{ color: S.muted, fontSize: 10.5, lineHeight: 1.45 }}><span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.gold, letterSpacing: '.07em' }}>DONE WHEN · </span>{doneCondition}</div>}
                              {dose && <div style={{ color: S.muted2, fontSize: 10, lineHeight: 1.4 }}><span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, letterSpacing: '.07em' }}>DOSE · </span>{dose}</div>}
                            </div>
                          )}

                          {!done && (
                            <div style={{ borderTop: `1px solid ${S.line}`, padding: '9px 12px' }}>
                              <button
                                type="button"
                                disabled={mutating}
                                onClick={() => {
                                  setResultOpenQuestId(current => current === quest.id ? null : quest.id)
                                  setResultNote('')
                                }}
                                style={{ border: 'none', background: 'transparent', padding: 2, color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, letterSpacing: '.07em', cursor: 'pointer' }}
                              >
                                {resultOpen ? 'CLOSE RESULT' : 'COULDN’T FULLY COMPLETE? LOG RESULT'}
                              </button>
                              {resultOpen && (
                                <div style={{ marginTop: 9 }}>
                                  <textarea
                                    value={resultNote}
                                    onChange={event => setResultNote(event.target.value.slice(0, 1000))}
                                    placeholder="Optional: what got in the way? One sentence is enough."
                                    rows={2}
                                    maxLength={1000}
                                    style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: `1px solid ${S.lineStrong}`, borderRadius: 9, background: S.panel2, color: S.ink, padding: '9px 10px', fontFamily: 'inherit', fontSize: 16, lineHeight: 1.4, outline: 'none' }}
                                  />
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 7, marginTop: 8 }}>
                                    {(['partial', 'skipped', 'failed'] as const).map(outcome => (
                                      <button
                                        key={outcome}
                                        type="button"
                                        disabled={mutating}
                                        onClick={() => { void recordQuestResult(quest.id, outcome, resultNote) }}
                                        style={{ minHeight: 38, border: `1px solid ${S.lineStrong}`, borderRadius: 9, background: outcome === 'partial' ? '#171c24' : 'transparent', color: outcome === 'failed' ? S.red : S.ink, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, letterSpacing: '.06em', cursor: 'pointer' }}
                                      >
                                        {outcome.toUpperCase()}
                                      </button>
                                    ))}
                                  </div>
                                  <div style={{ marginTop: 7, color: S.muted2, fontSize: 9.5, lineHeight: 1.4 }}>This records what happened. The System learns the likely barrier separately; it does not treat a skip as a character judgment.</div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </main>
        )}

        {adjustedQuests.length > 0 && (
          <section style={{ marginTop: 27 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 8.5, letterSpacing: '.13em', marginBottom: 8 }}>RESULTS / CHANGED BY THE SYSTEM</div>
            <div style={{ border: `1px solid ${S.line}`, borderRadius: 14, background: S.panel2, overflow: 'hidden' }}>
              {adjustedQuests.map((quest, index) => (
                <div key={quest.id} style={{ padding: '11px 13px', borderTop: index ? `1px solid ${S.line}` : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                    <div style={{ color: S.muted, fontSize: 12.5, textDecoration: quest.status === 'replaced' || quest.status === 'cancelled' ? 'line-through' : 'none' }}>{quest.title}</div>
                    <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: quest.status === 'failed' ? S.red : S.amber, fontSize: 8, letterSpacing: '.08em' }}>{quest.status.toUpperCase()}</div>
                  </div>
                  {quest.interrupt_reason && <div style={{ marginTop: 4, color: S.muted2, fontSize: 10.5, lineHeight: 1.4 }}>{quest.interrupt_reason}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        {dailyPlanReady && (
          <div id="update-system" style={{ marginTop: 27, scrollMarginTop: 16 }}>
            <UpdateSystemComposer variant="compact" onSaved={handleSystemUpdateSaved} />
          </div>
        )}

        <footer style={{ padding: '32px 0 10px', textAlign: 'center' }}>
          <div style={{ color: S.muted2, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, lineHeight: 1.6 }}>DAILY QUEST IS SYSTEM-OWNED<br />STRATEGIC TARGET · EXECUTABLE PLAN · RESPONSE LEARNING · EXPLICIT INTERRUPTS</div>
          <Link href="/" style={{ display: 'inline-block', marginTop: 15, color: S.muted, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>← SWITCH PLAYER</Link>
          {generationErrorMessage && process.env.NODE_ENV !== 'production' && <div style={{ marginTop: 12, color: S.red, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5 }}>DEBUG · {generationErrorCode ?? 'unknown'} · {generationErrorMessage}</div>}
        </footer>
      </div>
    </div>
  )
}

function SystemEmptyState({
  generationStatus,
  needsPlayerContext,
  generationFailed,
  transportInterrupted,
  systemPaused,
  onRetry,
}: {
  generationStatus: AiInferenceJobStatus | 'idle'
  needsPlayerContext: boolean
  generationFailed: boolean
  transportInterrupted: boolean
  systemPaused: boolean
  onRetry: () => void
}) {
  const queued = generationStatus === 'queued'
  const running = generationStatus === 'running'
  let eyebrow = 'CHECK-IN RECEIVED'
  let title = 'System is choosing today’s progression target.'
  let body = 'It first decides what outcome or bottleneck deserves movement today, then generates feasible candidate actions and a small portfolio.'
  if (queued) { eyebrow = 'INTELLIGENCE CYCLE QUEUED'; title = 'Check-in received.'; body = 'System will build today’s strategic target and executable plan as soon as the progression worker picks up this cycle.' }
  else if (running) { eyebrow = 'SYSTEM DECIDING'; title = 'System is finding the bottleneck worth moving…'; body = 'Progression Map, response history, feasibility, and today context are being combined before any quest is selected.' }
  else if (systemPaused) { eyebrow = 'SYSTEM TEMPORARILY PAUSED'; title = 'Your check-in is safe.'; body = 'System processing is temporarily unavailable. You do not need to enter today context again.' }
  else if (transportInterrupted) { eyebrow = 'PROCESSING INTERRUPTED'; title = 'Your check-in is safe.'; body = 'The reasoning connection was interrupted. Retry processing without rewriting today context.' }
  else if (generationFailed) { eyebrow = 'SYSTEM COULD NOT FINISH'; title = 'Your check-in is still safe.'; body = 'System could not finish this intelligence cycle. Retry without duplicating today context.' }
  else if (needsPlayerContext) { eyebrow = 'MORE PLAYER CONTEXT NEEDED'; title = 'The System needs one real life update first.'; body = 'Today context is saved separately. Use Update System below for the permanent/current player evidence the progression engine is missing.' }
  const canRetry = generationFailed || transportInterrupted

  return (
    <section style={{ marginTop: 12, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 17, padding: '17px 15px' }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.amber, letterSpacing: '.14em' }}>{eyebrow}</div>
      <div style={{ marginTop: 7, fontFamily: '"Space Grotesk", sans-serif', fontSize: 18, fontWeight: 700, lineHeight: 1.2 }}>{title}</div>
      <div style={{ marginTop: 8, color: S.muted, fontSize: 12, lineHeight: 1.55 }}>{body}</div>
      {canRetry && (
        <button type="button" onClick={onRetry} style={{ width: '100%', minHeight: 43, marginTop: 13, borderRadius: 10, border: 'none', background: S.amber, color: S.bg, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, fontWeight: 700, letterSpacing: '.07em', cursor: 'pointer' }}>RETRY PROCESSING</button>
      )}
    </section>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ background: S.panel, border: `1px solid ${S.line}`, borderRadius: 13, padding: '11px 12px' }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.gold, fontWeight: 700, fontSize: 'clamp(17px,5vw,22px)', lineHeight: 1 }}>{value}</div>
      <div style={{ marginTop: 5, fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 8, letterSpacing: '.09em' }}>{label}</div>
    </div>
  )
}
