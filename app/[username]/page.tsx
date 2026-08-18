'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { CATEGORY_LABEL, CATEGORY_ORDER, Category, todayStr, toDateStr } from '@/lib/checklist-data'
import {
  getAiInferenceJob,
  getAiInferenceJobForDate,
  requestDailyQuestGeneration,
  type AiInferenceJobStatus,
} from '@/lib/ai/inference-job-service'
import { legacyItemToQuest, questKindLabel } from '@/lib/quest-system'

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#10141b', line: '#232a35',
  ink: '#ECEAE3', muted: '#7e8795', amber: '#f6b24b', gold: '#ffd488', red: '#e5687a',
} as const

interface Item {
  id: string
  label: string
  category: Category
  anchor: boolean
  sort_order: number
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
  status: 'pending' | 'completed' | 'partial' | 'skipped' | 'failed'
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

export default function ChecklistPage() {
  const params = useParams()
  const router = useRouter()
  const username = decodeURIComponent(params.username as string)

  const [userId, setUserId] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [generatedQuests, setGeneratedQuests] = useState<GeneratedQuest[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [streak, setStreak] = useState(0)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [filter, setFilter] = useState<'semua' | Category>('semua')
  const [generationStatus, setGenerationStatus] = useState<AiInferenceJobStatus | 'idle'>('idle')
  const [generationError, setGenerationError] = useState<string | null>(null)

  const checkedRef = useRef<string[]>([])
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchedJobRef = useRef<string | null>(null)

  useEffect(() => {
    checkedRef.current = checked
  }, [checked])

  const legacyQuests = useMemo(() => items.map(legacyItemToQuest), [items])
  const quests = useMemo(() => generatedQuests.length > 0 ? generatedQuests : legacyQuests, [generatedQuests, legacyQuests])
  const usingGeneratedQuests = generatedQuests.length > 0
  const anchorIds = useMemo(() => items.filter(item => item.anchor).map(item => item.id), [items])
  const total = quests.length
  const completed = checked.length
  const pct = total ? Math.round((completed / total) * 100) : 0
  const xpEarned = quests.filter(q => checked.includes(q.id)).reduce((sum, q) => sum + q.xp, 0)
  const xpTotal = quests.reduce((sum, q) => sum + q.xp, 0)
  const mainQuests = quests.filter(q => q.kind === 'main')
  const mainDone = mainQuests.filter(q => checked.includes(q.id)).length
  const systemMessage = mainDone === mainQuests.length && mainQuests.length > 0
    ? 'Main Quest complete. Hari ini sudah aman — lanjutkan side quest kalau energi masih ada.'
    : mainQuests.length > 0
      ? `${mainQuests.length - mainDone} Main Quest masih aktif. Sistem menyarankan selesaikan ini sebelum mengejar bonus.`
      : usingGeneratedQuests
        ? 'Quest batch hari ini aktif. Sistem akan memakai hasil eksekusinya sebagai signal untuk progression berikutnya.'
        : generationStatus === 'running'
          ? 'System sedang menganalisis Player Knowledge dan menyusun progression.'
          : generationStatus === 'queued'
            ? 'System sudah menjadwalkan progression hari ini dan sedang menunggu AI worker.'
            : generationStatus === 'blocked_auth'
              ? 'AI worker perlu menyambungkan ulang sesi ChatGPT sebelum reasoning bisa lanjut.'
              : 'System otomatis memicu AI dari Life Vault update dan daily checkpoint. Legacy checklist hanya fallback sementara.'

  const refreshStreak = useCallback(async (uid: string, anchors: string[]) => {
    const from60 = toDateStr(new Date(Date.now() - 60 * 864e5))
    const { data } = await supabase
      .from('daily_logs')
      .select('date, checked_ids')
      .eq('user_id', uid)
      .gte('date', from60)
    setStreak(computeStreak(data ?? [], anchors))
  }, [])

  const loadGeneratedQuests = useCallback(async (uid: string) => {
    const { data, error } = await supabase
      .from('daily_quests')
      .select('id,title,category,kind,difficulty,priority,xp,rationale,source,status')
      .eq('user_id', uid)
      .eq('quest_date', todayStr())
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)

    const rows = (data ?? []) as GeneratedQuest[]
    setGeneratedQuests(rows)
    if (rows.length > 0) {
      const completedIds = rows.filter(row => row.status === 'completed').map(row => row.id)
      checkedRef.current = completedIds
      setChecked(completedIds)
    }
    return rows.length
  }, [])

  const watchGenerationJob = useCallback(async (jobId: string, uid: string) => {
    if (watchedJobRef.current === jobId) return
    watchedJobRef.current = jobId

    try {
      for (let index = 0; index < 120; index += 1) {
        if (index > 0) await delay(1500)
        const current = await getAiInferenceJob(supabase, jobId)
        if (!current) throw new Error('System inference job disappeared')

        setGenerationStatus(current.status)

        if (current.status === 'succeeded') {
          const count = await loadGeneratedQuests(uid)
          if (count === 0) {
            setGenerationError('System selesai memproses context, tapi belum ada quest yang bisa dipersist untuk hari ini.')
          } else {
            setGenerationError(null)
          }
          return
        }

        if (current.status === 'failed' || current.status === 'blocked_auth') {
          setGenerationError(current.errorMessage ?? (current.status === 'blocked_auth'
            ? 'ChatGPT worker session perlu login ulang.'
            : 'AI progression gagal diproses.'))
          return
        }
      }

      setGenerationError('System job masih queued terlalu lama. AI worker belum mengambil job ini; manual retry tidak akan membuat duplicate quest.')
    } catch (error) {
      setGenerationStatus('failed')
      setGenerationError(error instanceof Error ? error.message : 'System gagal memantau AI progression.')
    } finally {
      if (watchedJobRef.current === jobId) watchedJobRef.current = null
    }
  }, [loadGeneratedQuests])

  const syncAutomaticGeneration = useCallback(async (uid: string) => {
    const job = await getAiInferenceJobForDate(supabase, uid, todayStr())
    if (!job) {
      setGenerationStatus('idle')
      return
    }

    setGenerationStatus(job.status)

    if (job.status === 'succeeded') {
      await loadGeneratedQuests(uid)
      return
    }

    if (job.status === 'failed' || job.status === 'blocked_auth') {
      setGenerationError(job.errorMessage ?? (job.status === 'blocked_auth'
        ? 'ChatGPT worker session perlu login ulang.'
        : 'AI progression gagal diproses.'))
      return
    }

    void watchGenerationJob(job.id, uid)
  }, [loadGeneratedQuests, watchGenerationJob])

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null

    async function init() {
      const { data: user } = await supabase.from('users').select('id').eq('name', username).single()
      if (!user) {
        router.push('/')
        return
      }

      setUserId(user.id)

      const { data: itemRows } = await supabase
        .from('checklist_items')
        .select('id,label,category,anchor,sort_order')
        .eq('user_id', user.id)
        .eq('is_deleted', false)
        .order('sort_order', { ascending: true })

      const activeItems = itemRows ?? []
      setItems(activeItems)

      const generatedCount = await loadGeneratedQuests(user.id)
      const today = todayStr()

      if (generatedCount === 0) {
        const { data: log } = await supabase
          .from('daily_logs')
          .select('checked_ids')
          .eq('user_id', user.id)
          .eq('date', today)
          .single()

        setChecked(log?.checked_ids ?? [])
        await syncAutomaticGeneration(user.id)

        channel = supabase
          .channel(`logs:${user.id}:${today}`)
          .on('postgres_changes',
            { event: '*', schema: 'public', table: 'daily_logs', filter: `user_id=eq.${user.id}` },
            payload => {
              const row = payload.new as { date: string; checked_ids: string[] }
              if (row?.date !== todayStr()) return
              const incoming = row.checked_ids ?? []
              const same = incoming.length === checkedRef.current.length && incoming.every(id => checkedRef.current.includes(id))
              if (!same) setChecked(incoming)
            }
          )
          .subscribe()
      }

      await refreshStreak(user.id, activeItems.filter(item => item.anchor).map(item => item.id))
      setLoading(false)
    }

    void init().catch(() => {
      setGenerationError('System gagal memuat player state.')
      setLoading(false)
    })
    return () => { if (channel) supabase.removeChannel(channel) }
  }, [username, router, refreshStreak, loadGeneratedQuests, syncAutomaticGeneration])

  const persist = useCallback((next: string[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setStatus('saving')

    saveTimer.current = setTimeout(async () => {
      if (!userId) return
      const { error } = await supabase.from('daily_logs').upsert(
        {
          user_id: userId,
          date: todayStr(),
          checked_ids: next,
          item_count: total,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,date' }
      )

      if (error) {
        setStatus('idle')
        return
      }

      setStatus('saved')
      await refreshStreak(userId, anchorIds)
      setTimeout(() => setStatus('idle'), 1400)
    }, 450)
  }, [userId, total, refreshStreak, anchorIds])

  const toggle = useCallback((id: string) => {
    if (usingGeneratedQuests) {
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
        setGeneratedQuests(current => current.map(quest => quest.id === id
          ? { ...quest, status: willComplete ? 'completed' : 'pending' }
          : quest
        ))
        setStatus('saved')
        setTimeout(() => setStatus('idle'), 1400)
      })
      return
    }

    setChecked(prev => {
      const next = prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id]
      persist(next)
      return next
    })
  }, [persist, usingGeneratedQuests])

  const generateToday = useCallback(async () => {
    if (!userId || generationStatus === 'queued' || generationStatus === 'running') return
    setGenerationError(null)

    try {
      const job = await requestDailyQuestGeneration(supabase, todayStr())
      setGenerationStatus(job.status)

      if (job.status === 'succeeded') {
        await loadGeneratedQuests(userId)
        return
      }

      await watchGenerationJob(job.id, userId)
    } catch (error) {
      setGenerationStatus('failed')
      setGenerationError(error instanceof Error ? error.message : 'Generation gagal dijalankan.')
    }
  }, [generationStatus, loadGeneratedQuests, userId, watchGenerationJob])

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', background: S.bg, display: 'grid', placeItems: 'center', color: S.muted, fontFamily: '"IBM Plex Mono", monospace' }}>
        INITIALIZING SYSTEM...
      </div>
    )
  }

  const visibleCategories = filter === 'semua' ? CATEGORY_ORDER : [filter]
  const generationBusy = generationStatus === 'queued' || generationStatus === 'running'
  const manualButtonLabel = generationStatus === 'queued'
    ? 'WAITING FOR AI WORKER...'
    : generationStatus === 'running'
      ? 'CHATGPT REASONING...'
      : generationStatus === 'failed' || generationStatus === 'blocked_auth'
        ? 'RETRY AI JOB'
        : 'RUN NOW (FALLBACK)'

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
              {usingGeneratedQuests
                ? 'Quest hari ini dipersist dari bounded Player Knowledge reasoning. Refresh tidak akan mengganti quest batch yang sama.'
                : 'System otomatis memproses Life Vault update dan daily checkpoint. User tidak perlu membuat checklist atau menekan generate untuk memicu AI.'}
            </p>
          </div>

          {!usingGeneratedQuests && (
            <div style={{ marginTop: 18, background: S.panel, border: `1px solid ${S.line}`, borderRadius: 14, padding: 14 }}>
              <button
                type="button"
                onClick={generateToday}
                disabled={generationBusy}
                style={{
                  width: '100%', border: 'none', borderRadius: 10, padding: '12px 16px',
                  background: generationBusy ? '#3a3328' : S.amber,
                  color: generationBusy ? S.muted : S.bg,
                  fontFamily: '"IBM Plex Mono", monospace', fontWeight: 700, fontSize: 11,
                  letterSpacing: '.08em', cursor: generationBusy ? 'default' : 'pointer',
                }}
              >
                {manualButtonLabel}
              </button>
              {generationError && (
                <div style={{ color: S.red, fontSize: 11, lineHeight: 1.45, marginTop: 10 }}>{generationError}</div>
              )}
              <div style={{ color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, lineHeight: 1.5, marginTop: 10 }}>
                AUTO: Life Vault event + daily 04:00 checkpoint → AI worker → validation → Supabase. Button di atas hanya retry/fallback.
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 22 }}>
            <Stat value={`${pct}%`} label="PROGRESS" />
            <Stat value={`${xpEarned}/${xpTotal}`} label="XP" />
            <Stat value={`${streak}`} label="STREAK" />
          </div>

          <div style={{ marginTop: 12, height: 6, background: '#1c222c', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: `linear-gradient(90deg,${S.amber},${S.gold})`, transition: 'width 400ms ease' }} />
          </div>

          <div style={{ marginTop: 14, background: S.panel2, border: `1px solid ${S.line}`, borderRadius: 14, padding: '13px 14px' }}>
            <div style={{ fontFamily: '"IBM Plex Mono", monospace', color: S.amber, fontSize: 9, letterSpacing: '.12em' }}>SYSTEM ASSESSMENT · {usingGeneratedQuests ? 'AI BATCH' : 'LEGACY FALLBACK'}</div>
            <div style={{ color: S.ink, fontSize: 12.5, lineHeight: 1.5, marginTop: 6 }}>{systemMessage}</div>
          </div>

          <div style={{ height: 14, marginTop: 8, fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, color: status === 'saved' ? S.amber : S.muted, opacity: status === 'idle' ? 0 : 1 }}>
            {status === 'saving' ? 'SYNCING...' : status === 'saved' ? '✓ QUEST STATE SAVED' : ''}
          </div>
        </header>

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
                          display: 'flex',
                          gap: 13,
                          padding: '15px 16px',
                          borderTop: index === 0 ? 'none' : `1px solid ${S.line}`,
                          cursor: 'pointer',
                          background: done ? 'rgba(246,178,75,.035)' : 'transparent',
                        }}
                      >
                        <span style={{
                          width: 22,
                          height: 22,
                          flexShrink: 0,
                          borderRadius: 7,
                          border: done ? 'none' : '1.5px solid #39414e',
                          display: 'grid',
                          placeItems: 'center',
                          background: done ? `linear-gradient(135deg,${S.amber},${S.gold})` : 'transparent',
                          boxShadow: done ? '0 0 14px rgba(246,178,75,.4)' : 'none',
                          marginTop: 2,
                        }}>
                          {done ? '✓' : ''}
                        </span>

                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: quest.kind === 'main' ? S.amber : S.muted, letterSpacing: '.1em' }}>
                              {questKindLabel[quest.kind]}
                            </span>
                            <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, color: S.gold }}>+{quest.xp} XP</span>
                          </div>
                          <div style={{ marginTop: 5, fontSize: 14.5, lineHeight: 1.45, color: done ? S.muted : S.ink, textDecoration: done ? 'line-through' : 'none' }}>
                            {quest.title}
                          </div>
                          {usingGeneratedQuests && 'rationale' in quest && quest.rationale && (
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

        <footer style={{ padding: '32px 0 10px', textAlign: 'center' }}>
          <div style={{ color: S.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 9, lineHeight: 1.6 }}>
            QUEST AUTHORING IS SYSTEM-OWNED<br />
            {usingGeneratedQuests ? 'persisted AI quest batch is canonical for today' : 'legacy checklist is fallback until AI batch exists'}
          </div>
          <Link href="/" style={{ display: 'inline-block', marginTop: 16, color: S.muted, textDecoration: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 10 }}>
            ← SWITCH PLAYER
          </Link>
        </footer>
      </div>
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
