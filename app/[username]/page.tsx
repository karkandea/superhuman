'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import DailyContextCheckin from './daily-context-checkin'
import SystemInterruptFeed from './system-interrupt-feed'
import { supabase } from '@/lib/supabase'
import { CATEGORY_LABEL, CATEGORY_ORDER, Category, todayStr, toDateStr } from '@/lib/checklist-data'
import { getDailyContextForDate } from '@/lib/daily-context-service'
import type { DailyContextSnapshot } from '@/lib/daily-context'
import { getDailyPlanState, type DailyPlanState } from '@/lib/daily-plan-service'
import { requestDailyQuestGeneration } from '@/lib/ai/inference-job-service'
import { getPlayerWorkflowStatus, type PlayerWorkflowStatus } from '@/lib/player-workflow-status'
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

function formatDurationRange(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} detik`
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `${minutes} menit`
}

function workflowEtaCopy(workflow: PlayerWorkflowStatus) {
  if (workflow.longerThanUsual) return 'Lebih lama dari biasanya, tapi masih jalan.'
  if (workflow.etaP50Ms && workflow.etaP80Ms && (workflow.etaSampleCount ?? 0) >= 5) {
    const low = formatDurationRange(workflow.etaP50Ms)
    const high = formatDurationRange(workflow.etaP80Ms)
    return low === high ? `Biasanya sekitar ${low}.` : `Biasanya sekitar ${low}–${high}.`
  }
  return 'System masih jalan.'
}

export default function DailyQuestPage() {
  const params = useParams()
  const router = useRouter()
  const username = decodeURIComponent(params.username as string)
  const [userId, setUserId] = useState<string | null>(null)
  const [dailyContext, setDailyContext] = useState<DailyContextSnapshot | null>(null)
  const [dailyPlan, setDailyPlan] = useState<DailyPlanState | null>(null)
  const [workflow, setWorkflow] = useState<PlayerWorkflowStatus | null>(null)
  const [workflowUnavailable, setWorkflowUnavailable] = useState(false)
  const [allQuests, setAllQuests] = useState<GeneratedQuest[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [streak, setStreak] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [mutatingQuestIds, setMutatingQuestIds] = useState<Set<string>>(new Set())
  const [resultOpenQuestId, setResultOpenQuestId] = useState<string | null>(null)
  const [resultNote, setResultNote] = useState('')
  const checkedRef = useRef<string[]>([])
  const autoStartRef = useRef(false)

  useEffect(() => { checkedRef.current = checked }, [checked])

  const quests = allQuests.filter(quest => ['pending', 'partial', 'completed'].includes(quest.status))
  const adjustedQuests = allQuests.filter(quest => ['deferred', 'cancelled', 'replaced', 'skipped', 'failed'].includes(quest.status))
  const questReady = allQuests.length > 0
  const dailyPlanReady = questReady || Boolean(dailyPlan?.finalized)
  const total = quests.length
  const completed = quests.filter(quest => quest.status === 'completed').length
  const pct = total ? Math.round((completed / total) * 100) : 0
  const xpEarned = quests.filter(quest => quest.status === 'completed').reduce((sum, quest) => sum + quest.xp, 0)
  const mainQuests = quests.filter(quest => quest.kind === 'main')
  const mainDone = mainQuests.filter(quest => quest.status === 'completed').length
  const generationBusy = workflow?.turnOwner === 'system' && ['queued', 'running'].includes(workflow.activity)

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
    try {
      setWorkflow(await getPlayerWorkflowStatus(supabase, todayStr()))
      setWorkflowUnavailable(false)
    } catch {
      setWorkflowUnavailable(true)
    }
  }, [loadDailyPlan, loadGeneratedQuests, userId])

  const syncAutomaticGeneration = useCallback(async (uid: string) => {
    const next = await getPlayerWorkflowStatus(supabase, todayStr())
    setWorkflow(next)
    setWorkflowUnavailable(false)

    if (next.phase === 'quest_ready' || next.phase === 'no_action' || next.activity === 'ready') {
      await Promise.all([loadGeneratedQuests(uid), loadDailyPlan(uid)])
    }
    return next
  }, [loadDailyPlan, loadGeneratedQuests])

  const startGenerationAfterCheckin = useCallback(async (uid: string) => {
    await requestDailyQuestGeneration(supabase, todayStr())
    return syncAutomaticGeneration(uid)
  }, [syncAutomaticGeneration])

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
      const [generatedCount, plan, context, currentWorkflow] = await Promise.all([
        loadGeneratedQuests(user.id),
        loadDailyPlan(user.id),
        getDailyContextForDate(supabase, user.id, todayStr()),
        getPlayerWorkflowStatus(supabase, todayStr()),
      ])
      if (cancelled) return
      setDailyContext(context)
      setWorkflow(currentWorkflow)
      setWorkflowUnavailable(false)

      if (generatedCount === 0 && !plan.finalized && context && currentWorkflow.canStart && !autoStartRef.current) {
        autoStartRef.current = true
        await startGenerationAfterCheckin(user.id)
      }
      await refreshStreak(user.id, anchorIds)
      if (!cancelled) setLoading(false)
    }
    void init().catch(() => {
      if (cancelled) return
      setWorkflowUnavailable(true)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [username, router, refreshStreak, loadGeneratedQuests, loadDailyPlan, startGenerationAfterCheckin])

  useEffect(() => {
    if (!userId || !workflow) return
    const shouldPoll = workflow.turnOwner === 'system' && (
      ['queued', 'running', 'stalled'].includes(workflow.activity)
      || (workflow.activity === 'failed' && workflow.recoveryAvailable)
    )
    if (!shouldPoll) return
    const delayMs = workflow.activity === 'stalled' ? 10000 : 3000
    const timer = window.setInterval(() => {
      void syncAutomaticGeneration(userId).catch(() => setWorkflowUnavailable(true))
    }, delayMs)
    return () => window.clearInterval(timer)
  }, [syncAutomaticGeneration, userId, workflow])

  useEffect(() => {
    if (!userId) return
    const handleKnowledgeSaved = () => {
      void syncAutomaticGeneration(userId).catch(() => setWorkflowUnavailable(true))
    }
    window.addEventListener('superhuman:knowledge-saved', handleKnowledgeSaved)
    return () => window.removeEventListener('superhuman:knowledge-saved', handleKnowledgeSaved)
  }, [syncAutomaticGeneration, userId])

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
      if (userId) void syncAutomaticGeneration(userId).catch(() => setWorkflowUnavailable(true))
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
      if (userId) void syncAutomaticGeneration(userId).catch(() => setWorkflowUnavailable(true))
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

  async function checkGenerationStatus() {
    if (!userId || checkingStatus) return
    setCheckingStatus(true)
    try {
      await syncAutomaticGeneration(userId)
    } catch {
      setWorkflowUnavailable(true)
    } finally {
      setCheckingStatus(false)
    }
  }

  function focusComposer() {
    const composer = document.getElementById('universal-system-update') as HTMLTextAreaElement | null
    composer?.focus()
  }

  async function handleDailyContextConfirmed(context: DailyContextSnapshot) {
    setDailyContext(context)
    if (!userId) return
    try {
      await startGenerationAfterCheckin(userId)
    } catch {
      setWorkflowUnavailable(true)
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', padding: '30px 18px 120px' }}>
          <div style={{ width: 120, height: 11, borderRadius: 8, background: S.line }} />
          <div style={{ width: 150, height: 42, borderRadius: 10, background: S.panel, marginTop: 10 }} />
          <div style={{ height: 128, borderRadius: 17, background: S.panel, border: `1px solid ${S.line}`, marginTop: 28 }} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', background: S.bg, color: S.ink, fontFamily: '"IBM Plex Sans", sans-serif' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '0 18px' }}>
        <header style={{ padding: '28px 0 14px' }}>
          <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted, fontSize: 9.5, letterSpacing: '.04em' }}>{new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <h1 style={{ fontFamily: '"Space Grotesk", sans-serif', fontSize: 'clamp(34px,9vw,46px)', lineHeight: .98, letterSpacing: '-.045em', margin: '7px 0 0' }}>Today</h1>

          {questReady && (
            <div style={{ marginTop: 17 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>
                <span style={{ color: S.gold }}>{completed}/{total} selesai</span>
                <span>{xpEarned} XP</span>
                <span>{streak} hari beruntun</span>
              </div>
              <div style={{ marginTop: 9, height: 4, background: '#1c222c', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: `linear-gradient(90deg,${S.amber},${S.gold})`, transition: 'width 400ms ease' }} />
              </div>
            </div>
          )}

          {dailyPlanReady && dailyPlan?.progressionTargetSummary && (
            <div style={{ marginTop: 14, padding: '10px 12px', borderLeft: `2px solid ${S.amber}`, background: 'rgba(246,178,75,.035)' }}>
              <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 8, letterSpacing: '.12em' }}>FOKUS HARI INI</div>
              <div style={{ color: '#d8d7d2', fontSize: 12.5, lineHeight: 1.48, marginTop: 4 }}>{dailyPlan.progressionTargetSummary}</div>
            </div>
          )}

          {dailyPlanReady && <SystemInterruptFeed playerId={userId} date={todayStr()} onApplied={refreshTodayQuests} />}

          <div aria-live="polite" style={{ height: 15, marginTop: 7, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: saveStatus === 'failed' ? S.red : saveStatus === 'saved' ? S.amber : S.muted, opacity: saveStatus === 'idle' ? 0 : 1 }}>
            {saveStatus === 'saving' ? 'MENYIMPAN…' : saveStatus === 'saved' ? '✓ Tersimpan' : saveStatus === 'failed' ? 'Belum tersimpan. Coba lagi.' : ''}
          </div>
        </header>

        {!dailyPlanReady && !dailyContext && (
          <DailyContextCheckin
            date={todayStr()}
            context={dailyContext}
            generationBusy={generationBusy}
            onConfirmed={handleDailyContextConfirmed}
          />
        )}

        {!dailyPlanReady && dailyContext && (
          <SystemEmptyState
            workflow={workflow}
            unavailable={workflowUnavailable}
            checking={checkingStatus}
            onAnswer={focusComposer}
            onCheckStatus={() => { void checkGenerationStatus() }}
          />
        )}

        {dailyPlan?.noQuest && quests.length === 0 && (
          <section style={{ marginTop: 8, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 17, padding: '18px 16px' }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.amber, letterSpacing: '.13em' }}>KEPUTUSAN SYSTEM</div>
            <div style={{ marginTop: 7, fontFamily: '"Space Grotesk", sans-serif', fontSize: 19, fontWeight: 700, lineHeight: 1.2 }}>Nggak ada quest yang perlu ditambah.</div>
            {dailyPlan.noQuestReason && <div style={{ marginTop: 7, color: S.muted, fontSize: 12, lineHeight: 1.5 }}>{dailyPlan.noQuestReason}</div>}
          </section>
        )}

        {quests.length > 0 && (
          <main style={{ marginTop: 8 }}>
            {CATEGORY_ORDER.map(category => {
              const categoryQuests = quests.filter(quest => quest.category === category)
              if (!categoryQuests.length) return null
              return (
                <section key={category} style={{ marginTop: 18 }}>
                  <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.muted2, letterSpacing: '.11em', margin: '0 2px 7px' }}>{CATEGORY_LABEL[category].toUpperCase()}</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {categoryQuests.map((quest) => {
                      const done = checked.includes(quest.id)
                      const mutating = mutatingQuestIds.has(quest.id)
                      const why = strategicWhy(quest)
                      const doneCondition = doneWhen(quest)
                      const dose = questDose(quest)
                      const resultOpen = resultOpenQuestId === quest.id
                      return (
                        <article key={quest.id} style={{ border: `1px solid ${quest.interrupt_id ? '#443a24' : S.line}`, borderRadius: 16, background: quest.interrupt_id ? 'linear-gradient(135deg,#17150f,#13171f)' : done ? 'rgba(246,178,75,.025)' : S.panel, overflow: 'hidden', opacity: mutating ? .65 : 1 }}>
                          <button
                            type="button"
                            onClick={() => toggle(quest.id)}
                            disabled={mutating}
                            aria-pressed={done}
                            aria-label={`${done ? 'Tandai belum selesai' : 'Selesaikan'}: ${quest.title}`}
                            style={{ width: '100%', display: 'flex', gap: 13, textAlign: 'left', padding: '15px 14px 12px', border: 'none', cursor: mutating ? 'default' : 'pointer', background: 'transparent', color: 'inherit' }}
                          >
                            <span aria-hidden="true" style={{ width: 23, height: 23, flexShrink: 0, borderRadius: 7, border: done ? 'none' : '1.5px solid #39414e', display: 'grid', placeItems: 'center', background: done ? `linear-gradient(135deg,${S.amber},${S.gold})` : 'transparent', boxShadow: done ? '0 0 14px rgba(246,178,75,.3)' : 'none', marginTop: 1, color: S.bg, fontSize: 13, fontWeight: 800 }}>{done ? '✓' : ''}</span>
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <span style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.2, color: quest.kind === 'main' ? S.amber : S.muted, letterSpacing: '.08em' }}>{questKindLabel[quest.kind]}</span>
                                {quest.interrupt_id && <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.gold }}>SYSTEM INTERRUPT</span>}
                                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.2, color: S.gold }}>+{quest.xp} XP</span>
                              </span>
                              <span style={{ display: 'block', marginTop: 6, fontSize: 14.5, lineHeight: 1.4, color: done ? S.muted : S.ink, textDecoration: done ? 'line-through' : 'none' }}>{quest.title}</span>
                            </span>
                          </button>

                          {(why || doneCondition || dose) && (
                            <div style={{ padding: '0 14px 12px 50px', display: 'grid', gap: 5 }}>
                              {why && <div style={{ color: S.muted, fontSize: 10.5, lineHeight: 1.45 }}><span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.amber }}>KENAPA · </span>{why}</div>}
                              {doneCondition && <div style={{ color: S.muted, fontSize: 10.5, lineHeight: 1.45 }}><span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8, color: S.gold }}>SELESAI KALAU · </span>{doneCondition}</div>}
                              {dose && <div style={{ color: S.muted2, fontSize: 10, lineHeight: 1.4 }}><span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8 }}>PORSI · </span>{dose}</div>}
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
                                style={{ border: 'none', background: 'transparent', padding: 2, color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.3, cursor: 'pointer' }}
                              >
                                {resultOpen ? 'TUTUP' : 'HASILNYA BEDA?'}
                              </button>
                              {resultOpen && (
                                <div style={{ marginTop: 9 }}>
                                  <textarea
                                    value={resultNote}
                                    onChange={event => setResultNote(event.target.value.slice(0, 1000))}
                                    placeholder="Apa yang terjadi? Opsional."
                                    rows={2}
                                    maxLength={1000}
                                    style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: `1px solid ${S.lineStrong}`, borderRadius: 10, background: S.panel2, color: S.ink, padding: '9px 10px', fontFamily: 'inherit', fontSize: 15, lineHeight: 1.4, outline: 'none' }}
                                  />
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 7, marginTop: 8 }}>
                                    {(['partial', 'skipped', 'failed'] as const).map(outcome => (
                                      <button
                                        key={outcome}
                                        type="button"
                                        disabled={mutating}
                                        onClick={() => { void recordQuestResult(quest.id, outcome, resultNote) }}
                                        style={{ minHeight: 38, border: `1px solid ${S.lineStrong}`, borderRadius: 9, background: outcome === 'partial' ? '#171c24' : 'transparent', color: outcome === 'failed' ? S.red : S.ink, fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, cursor: 'pointer' }}
                                      >
                                        {outcome === 'partial' ? 'SEBAGIAN' : outcome === 'skipped' ? 'DILEWATI' : 'GAGAL'}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </main>
        )}

        {adjustedQuests.length > 0 && (
          <section style={{ marginTop: 28 }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.muted2, fontSize: 8.5, letterSpacing: '.11em', marginBottom: 8 }}>SEBELUMNYA HARI INI</div>
            <div style={{ borderTop: `1px solid ${S.line}` }}>
              {adjustedQuests.map((quest) => (
                <div key={quest.id} style={{ padding: '10px 2px', borderBottom: `1px solid ${S.line}`, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ color: S.muted, fontSize: 12.5, textDecoration: quest.status === 'replaced' || quest.status === 'cancelled' ? 'line-through' : 'none' }}>{quest.title}</div>
                  <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: quest.status === 'failed' ? S.red : S.muted2, fontSize: 8 }}>{quest.status.toUpperCase()}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {mainQuests.length > 0 && mainDone === mainQuests.length && (
          <div style={{ marginTop: 22, color: S.gold, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9 }}>✓ Main Quest selesai.</div>
        )}

        <footer style={{ height: 36 }} />
      </div>
    </div>
  )
}

function WorkflowLine({ done, active, children }: { done?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: done ? '#a8adaf' : active ? S.ink : S.muted, fontSize: 12, lineHeight: 1.4 }}>
      <span aria-hidden="true" style={{ width: 14, color: done ? S.gold : active ? S.amber : S.muted2 }}>{done ? '✓' : active ? '●' : '○'}</span>
      <span>{children}</span>
    </div>
  )
}

function SystemEmptyState({
  workflow,
  unavailable,
  checking,
  onAnswer,
  onCheckStatus,
}: {
  workflow: PlayerWorkflowStatus | null
  unavailable: boolean
  checking: boolean
  onAnswer: () => void
  onCheckStatus: () => void
}) {
  if (unavailable || !workflow) {
    return (
      <section style={{ marginTop: 12, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 17, padding: '20px 16px' }}>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.amber, letterSpacing: '.13em' }}>STATUS SYSTEM</div>
        <div style={{ marginTop: 8, fontFamily: '"Space Grotesk", sans-serif', fontSize: 19, fontWeight: 700 }}>Status belum kebaca</div>
        <div style={{ marginTop: 6, color: S.muted, fontSize: 12, lineHeight: 1.5 }}>Data lo tetap aman. Muat ulang status ini cuma membaca keadaan terbaru dan nggak memulai proses baru.</div>
        <button type="button" onClick={onCheckStatus} disabled={checking} style={{ minHeight: 40, marginTop: 13, borderRadius: 10, border: `1px solid ${S.lineStrong}`, background: 'transparent', color: S.ink, padding: '0 14px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: 'pointer' }}>{checking ? 'MEMUAT…' : 'MUAT ULANG STATUS'}</button>
      </section>
    )
  }

  if (workflow.phase === 'needs_more_context') {
    return (
      <section style={{ marginTop: 12, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 17, padding: '20px 16px' }}>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.gold, letterSpacing: '.13em' }}>GILIRAN LO</div>
        <div style={{ marginTop: 8, fontFamily: '"Space Grotesk", sans-serif', fontSize: 19, fontWeight: 700 }}>Ada satu yang belum kebaca</div>
        <div style={{ marginTop: 6, color: S.muted, fontSize: 12, lineHeight: 1.5 }}>Kasih satu konteks lagi biar System bisa lanjut.</div>
        <button type="button" onClick={onAnswer} style={{ minHeight: 40, marginTop: 13, border: 0, borderRadius: 10, background: S.amber, color: S.bg, padding: '0 14px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 800, cursor: 'pointer' }}>JAWAB →</button>
      </section>
    )
  }

  const systemOwnsTurn = workflow.turnOwner === 'system'
  const recoveryExhausted = systemOwnsTurn && workflow.activity === 'failed' && !workflow.recoveryAvailable
  const recovering = systemOwnsTurn && ['stalled', 'failed'].includes(workflow.activity) && !recoveryExhausted
  const active = systemOwnsTurn && ['queued', 'running', 'stalled', 'failed'].includes(workflow.activity)
  if (active) {
    return (
      <section style={{ marginTop: 12, background: S.panel, border: `1px solid ${recovering || recoveryExhausted ? '#443a24' : S.line}`, borderRadius: 17, padding: '20px 16px' }}>
        <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: recovering || recoveryExhausted ? S.gold : S.amber, letterSpacing: '.13em' }}>{recoveryExhausted ? 'SYSTEM MASIH PEGANG' : 'SYSTEM YANG LANJUT'}</div>
        <div style={{ marginTop: 8, fontFamily: '"Space Grotesk", sans-serif', fontSize: 19, fontWeight: 700 }}>{recoveryExhausted ? 'System belum bisa menyelesaikan proses' : recovering ? 'System lagi memulihkan proses' : 'Lagi nyiapin quest lo'}</div>
        {recoveryExhausted ? (
          <div style={{ display: 'grid', gap: 7, marginTop: 14 }}>
            <WorkflowLine done>Checkpoint dan jawaban lo tetap aman</WorkflowLine>
          </div>
        ) : recovering ? (
          <div style={{ display: 'grid', gap: 7, marginTop: 14 }}>
            <WorkflowLine active>Lagi melanjutkan dari checkpoint terakhir</WorkflowLine>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 7, marginTop: 14 }}>
            {workflow.phase === 'understanding' && <WorkflowLine active>Lagi memahami jawaban lo</WorkflowLine>}
            {workflow.phase !== 'understanding' && <WorkflowLine done>Cerita lo udah kebaca</WorkflowLine>}
            {workflow.phase === 'choosing_focus' && <WorkflowLine active>Lagi nentuin fokus hari ini</WorkflowLine>}
            {workflow.phase === 'preparing_quests' && <WorkflowLine done>Fokus hari ini udah dipilih</WorkflowLine>}
            {workflow.phase === 'preparing_quests' && <WorkflowLine active>Lagi nyusun quest</WorkflowLine>}
          </div>
        )}
        <div style={{ marginTop: 15, color: S.ink, fontSize: 12, lineHeight: 1.48, fontWeight: 600 }}>{recoveryExhausted ? 'Ini tetap masalah di System, bukan giliran lo.' : 'Bola ada di System. Lo nggak perlu ngapa-ngapain.'}</div>
        <div style={{ marginTop: 4, color: workflow.longerThanUsual || recovering || recoveryExhausted ? S.gold : S.muted2, fontSize: 10.5, lineHeight: 1.45 }}>{recoveryExhausted ? 'System nggak akan mengulang proses tanpa batas.' : recovering ? 'System akan mencoba lanjut otomatis.' : workflowEtaCopy(workflow)}</div>
      </section>
    )
  }

  return (
    <section style={{ marginTop: 12, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 17, padding: '20px 16px' }}>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, color: S.amber, letterSpacing: '.13em' }}>STATUS SYSTEM</div>
      <div style={{ marginTop: 8, fontFamily: '"Space Grotesk", sans-serif', fontSize: 19, fontWeight: 700 }}>Status belum siap</div>
      <div style={{ marginTop: 6, color: S.muted, fontSize: 12, lineHeight: 1.5 }}>Muat ulang status untuk membaca keadaan terbaru. Ini nggak memulai atau mengulang proses AI.</div>
      <button type="button" onClick={onCheckStatus} disabled={checking} style={{ minHeight: 40, marginTop: 13, borderRadius: 10, border: `1px solid ${S.lineStrong}`, background: 'transparent', color: S.ink, padding: '0 14px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 8.5, fontWeight: 700, cursor: 'pointer' }}>{checking ? 'MEMUAT…' : 'MUAT ULANG STATUS'}</button>
    </section>
  )
}
