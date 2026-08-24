import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import type { AiProvider, AiProviderResponse, ModelAudit } from './contracts'
import type { DailyQuestContextRetriever } from './orchestrator'
import { chooseProgressionTarget as chooseLegacyProgressionTarget } from './progression-intelligence-core'
import {
  PROGRESSION_MOVE_SCHEMA_VERSION,
  PROGRESSION_RESEARCH_MAX_PER_SESSION,
  PROGRESSION_RESEARCH_SCHEMA_VERSION,
  validateProgressionMoveDecision,
  validateProgressionResearchResult,
  type ProgressionMoveDecision,
  type ProgressionResearchPlan,
  type ProgressionResearchResult,
} from '../progression-conversation'
import {
  type ProgressionTargetDecision,
  type ProgressionTargetSnapshot,
} from '../progression-intelligence'
import type { ProgressionIntelligenceStore } from '../supabase/progression-intelligence-store'

interface SessionRow {
  id: string
  kind: 'initial_calibration' | 'progression' | 'reevaluation'
  title: string
  state: string
  target_date: string | null
}

interface ResearchRow {
  id: string
  topic: string
  research_question: string
  queries: unknown
  findings: string
  sources: unknown
  completed_at: string
}

function serviceKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

function conversationClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = serviceKey()
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function auditFrom(response: AiProviderResponse, schemaVersion: string): ModelAudit {
  return {
    providerId: response.providerId,
    modelId: response.modelId,
    requestId: response.requestId,
    conversationRef: response.conversationRef,
    schemaVersion,
  }
}

function dedupeKey(prefix: string, body: string) {
  return `${prefix}:${createHash('sha256').update(body).digest('hex').slice(0, 18)}`
}

async function rpcRow<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') throw new Error(`${fn} returned no row`)
  return row as T
}

async function ensureSession(client: SupabaseClient, playerId: string, date: string): Promise<SessionRow> {
  return rpcRow<SessionRow>(client, 'ensure_progression_session_operator', {
    p_user_id: playerId,
    p_target_date: date,
    p_job_id: null,
  })
}

async function setState(client: SupabaseClient, sessionId: string, state: string, metadata: Record<string, unknown> = {}) {
  await rpcRow(client, 'set_progression_session_state_operator', {
    p_session_id: sessionId,
    p_state: state,
    p_metadata: metadata,
  })
}

async function appendSystemMessage(
  client: SupabaseClient,
  sessionId: string,
  type: 'system_update' | 'clarification_question' | 'research_update' | 'decision' | 'wait',
  body: string,
  metadata: Record<string, unknown> = {},
) {
  await rpcRow(client, 'append_progression_message_operator', {
    p_session_id: sessionId,
    p_actor: 'system',
    p_message_type: type,
    p_body: body,
    p_metadata: metadata,
    p_dedupe_key: dedupeKey(type, body),
  })
}

async function loadResearch(client: SupabaseClient, sessionId: string): Promise<ResearchRow[]> {
  const { data, error } = await client
    .from('progression_research')
    .select('id,topic,research_question,queries,findings,sources,completed_at')
    .eq('session_id', sessionId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: true })
  if (error) throw new Error(`load progression research: ${error.message}`)
  return (data ?? []) as ResearchRow[]
}

async function questionCount(client: SupabaseClient, sessionId: string) {
  const { count, error } = await client
    .from('progression_questions')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
  if (error) throw new Error(`count progression questions: ${error.message}`)
  return Number(count ?? 0)
}

async function persistResearch(
  client: SupabaseClient,
  sessionId: string,
  plan: ProgressionResearchPlan,
  result: ProgressionResearchResult,
  response: AiProviderResponse,
) {
  await rpcRow(client, 'persist_progression_research_operator', {
    p_session_id: sessionId,
    p_topic: plan.topic,
    p_research_question: plan.question,
    p_queries: plan.queries,
    p_findings: result.findings,
    p_sources: result.sources,
    p_provider_id: response.providerId,
    p_model_id: response.modelId,
    p_request_id: response.requestId ?? null,
  })
}

async function createQuestion(client: SupabaseClient, sessionId: string, decision: ProgressionMoveDecision) {
  if (!decision.question) throw new Error('ASK progression move is missing its question')
  const question = await rpcRow<{ id: string }>(client, 'create_progression_question_operator', {
    p_session_id: sessionId,
    p_response_type: decision.question.responseType,
    p_prompt: decision.question.prompt,
    p_reason: decision.question.reason,
    p_options: decision.question.options,
  })
  await appendSystemMessage(client, sessionId, 'clarification_question', decision.question.prompt, {
    questionId: question.id,
    responseType: decision.question.responseType,
    options: decision.question.options,
  })
  await setState(client, sessionId, 'need_clarification', { questionId: question.id })
}

function compactResearch(rows: ResearchRow[]) {
  return rows.map(row => ({
    id: row.id,
    topic: row.topic,
    question: row.research_question,
    findings: row.findings,
    sources: Array.isArray(row.sources) ? row.sources : [],
    completedAt: row.completed_at,
  }))
}

async function runExternalResearch(
  provider: AiProvider,
  input: {
    playerId: string
    date: string
    plan: ProgressionResearchPlan
    worldContext: Record<string, unknown>
  },
) {
  const response = await provider.invokeStructured({
    operation: 'research_progression_context',
    schemaVersion: PROGRESSION_RESEARCH_SCHEMA_VERSION,
    instructions: [
      'Use external web search for this request. Do not answer from memory alone.',
      'Research the world around the player problem, never the player identity. Do not search names, usernames, email addresses, employers as identity lookup, social profiles, or other personal identifiers.',
      'The supplied worldContext is deliberately de-personalized. Treat it only as problem framing, not as permission to discover personal facts.',
      'Prefer recent primary or authoritative sources when the topic is time-sensitive. Use multiple independent sources when trade-offs or market claims are involved.',
      'Return only evidence that can materially change a progression decision. Preserve uncertainty and disagreements between sources.',
      'Every material claim in findings must be supportable by the returned source list. Never invent URLs or citations.',
    ].join(' '),
    context: {
      playerId: input.playerId,
      date: input.date,
      researchPlan: input.plan,
      worldContext: input.worldContext,
      playerFactPolicy: 'External research is world evidence only. Player facts come only from supplied private evidence outside this research request.',
    },
    responseContract: {
      type: 'object',
      required: ['findings', 'sources'],
      findings: 'compact synthesis focused on decision-relevant evidence and trade-offs',
      sources: [{
        title: 'source title',
        url: 'direct http(s) source URL actually used',
        publishedAt: 'optional date/version string when available',
        keyPoint: 'the exact decision-relevant point supported by this source',
      }],
    },
  })
  return { response, result: validateProgressionResearchResult(response.output) }
}

async function chooseMove(
  provider: AiProvider,
  input: {
    playerId: string
    date: string
    playerBrief: unknown
    dailyContext: unknown
    signals: Array<{ id: string } & Record<string, unknown>>
    recentQuestResults: unknown
    progressionMap: NonNullable<Awaited<ReturnType<ProgressionIntelligenceStore['loadCurrentProgressionMap']>>>
    playerResponseModel: unknown
    research: ResearchRow[]
    session: SessionRow
    researchBudgetRemaining: number
    questionBudgetRemaining: number
  },
) {
  const requireResearch = input.session.kind === 'initial_calibration' && input.research.length === 0
  const response = await provider.invokeStructured({
    operation: 'choose_progression_move',
    schemaVersion: PROGRESSION_MOVE_SCHEMA_VERSION,
    instructions: [
      'Choose the next progression move before any quest is generated. This is a decision gate, not a task generator and not free-form chat.',
      'Allowed nextAction values are ASK, RESEARCH, QUEST, DECIDE, WAIT (return lowercase enum values).',
      'ASK only when the answer can materially change the next decision and the uncertainty cannot be resolved from existing evidence or external research. Never repeat a question already answered.',
      'RESEARCH only when external world evidence can materially reduce uncertainty. Research must never look up the player identity or personal facts.',
      'QUEST only when evidence is sufficient to choose a causal move. Never transform the player problem into the task itself. If the player says they do not know which path to choose, do not make “choose a path” the quest.',
      'When uncertainty is the bottleneck, prefer an information-gain experiment: hypothesis -> small action -> observable real-world response -> better next decision.',
      'DECIDE means give a bounded recommendation/conclusion without creating a task. WAIT means no new action is justified until a named observation/condition changes.',
      'A good move either increases the probability of the player desired outcome or produces evidence that materially improves the next decision. Mere activity is not enough.',
      'Preserve materially decision-relevant player evidence. criticalSignalIds must include every supplied signal that materially changes the decision, including existing assets, traction, warm contacts, prior experience, active experiments, and previous market feedback when present.',
      'For QUEST, target must use the existing Progression Map and criticalSignalIds must include the provenance of every selected goal/outcome/bottleneck/opportunity node.',
      'Use research as world evidence, not as new facts about the player. Player Brief + private signals + observed quest results remain the source of truth about the player.',
      'playerUpdates are curated UI copy, not reasoning. Return at most two short, calm, meaningful updates. No chain-of-thought, motivational filler, or fake activity.',
      `Research budget remaining: ${input.researchBudgetRemaining}. Clarification question budget remaining: ${input.questionBudgetRemaining}.`,
      requireResearch ? 'This is the first post-onboarding progression decision. External research is required before QUEST, DECIDE, or WAIT.' : '',
      input.questionBudgetRemaining < 1 ? 'Do not return ASK; the bounded clarification budget is exhausted.' : '',
      input.researchBudgetRemaining < 1 ? 'Do not return RESEARCH; the bounded research budget is exhausted.' : '',
    ].filter(Boolean).join(' '),
    context: {
      playerId: input.playerId,
      date: input.date,
      playerBrief: input.playerBrief,
      dailyContext: input.dailyContext,
      signals: input.signals,
      recentQuestResults: input.recentQuestResults,
      progressionMap: input.progressionMap,
      playerResponseModel: input.playerResponseModel,
      externalResearch: compactResearch(input.research),
      session: { kind: input.session.kind, state: input.session.state },
    },
    responseContract: {
      type: 'object',
      required: ['nextAction', 'playerUpdates', 'criticalSignalIds', 'whyNow'],
      nextAction: ['ask', 'research', 'quest', 'decide', 'wait'],
      playerUpdates: '0–2 concise player-facing System updates; never hidden reasoning',
      criticalSignalIds: '0–12 ids from context.signals only; include all materially decision-changing player evidence used',
      whyNow: 'concise decision rationale; internal structured field, not chain-of-thought',
      question: { responseType: ['free_text', 'short_text', 'single_choice', 'multiple_choice'], prompt: 'materially decision-changing question', reason: 'which uncertainty this resolves', options: '0–6 concise options; required for choice types' },
      researchPlan: { topic: 'world/domain topic only', question: 'decision-relevant research question', queries: '1–4 bounded web queries without player identity lookup', reason: 'which uncertainty this reduces' },
      target: {
        mode: ['progress', 'maintenance_only', 'no_intervention'], summary: 'what should move today', primaryGoalId: 'optional map goal id', proximalOutcomeIds: 'map ids', bottleneckIds: 'map ids', opportunityIds: 'map ids', maintenanceIntent: 'optional', maxQuestCount: 'integer 0..5', rationale: 'concise causal reason', noQuestReason: 'required only for no_intervention',
      },
      conclusion: 'required only for DECIDE',
      waitFor: 'required only for WAIT; observable condition/evidence that should trigger reevaluation',
    },
  })

  const decision = validateProgressionMoveDecision(response.output, {
    progressionMap: input.progressionMap,
    allowedSignalIds: new Set(input.signals.map(signal => signal.id)),
    requireResearch,
    canQuest: Boolean(input.dailyContext),
    researchBudgetRemaining: input.researchBudgetRemaining,
  })
  return { response, decision }
}

function noInterventionDecision(decision: ProgressionMoveDecision): ProgressionTargetDecision {
  const summary = decision.nextAction === 'decide'
    ? decision.conclusion || 'System sudah punya kesimpulan untuk fase ini.'
    : 'Belum ada action baru yang cukup bernilai sekarang.'
  const noQuestReason = decision.nextAction === 'wait'
    ? decision.waitFor || decision.whyNow
    : decision.whyNow
  return {
    mode: 'no_intervention',
    summary,
    proximalOutcomeIds: [],
    bottleneckIds: [],
    opportunityIds: [],
    maxQuestCount: 0,
    rationale: decision.whyNow,
    noQuestReason,
  }
}

export async function chooseProgressionTarget(
  dependencies: {
    provider: AiProvider
    contextRetriever: DailyQuestContextRetriever
    store: ProgressionIntelligenceStore
  },
  input: { playerId: string; date: string; limit?: number },
): Promise<ProgressionTargetSnapshot> {
  const existing = await dependencies.store.loadProgressionTargetForDate(input.playerId, input.date)
  if (existing) return existing

  const client = conversationClient()
  if (!client) return chooseLegacyProgressionTarget(dependencies, input)

  const base = await dependencies.contextRetriever.retrieveForDailyQuest({
    playerId: input.playerId,
    date: input.date,
    limit: input.limit ?? 32,
  })
  if (!base.playerBrief) throw new Error('Canonical Player Brief is required for progression conversation')
  if (!base.dailyContext) throw new Error('Daily Context is required before choosing today progression move')

  const [progressionMap, playerResponseModel] = await Promise.all([
    dependencies.store.loadCurrentProgressionMap(input.playerId),
    dependencies.store.loadCurrentPlayerResponseModel(input.playerId),
  ])
  if (!progressionMap || progressionMap.version < 1) throw new Error('Progression Map is required before choosing today progression move')

  const session = await ensureSession(client, input.playerId, input.date)
  let research = await loadResearch(client, session.id)
  const usedQuestions = await questionCount(client, session.id)

  for (let pass = 0; pass < 3; pass += 1) {
    await setState(client, session.id, 'deciding', { pass: pass + 1 })
    const { response, decision } = await chooseMove(dependencies.provider, {
      playerId: input.playerId,
      date: input.date,
      playerBrief: base.playerBrief,
      dailyContext: base.dailyContext,
      signals: base.signals as Array<{ id: string } & Record<string, unknown>>,
      recentQuestResults: base.recentQuestResults,
      progressionMap,
      playerResponseModel,
      research,
      session,
      researchBudgetRemaining: Math.max(0, PROGRESSION_RESEARCH_MAX_PER_SESSION - research.length),
      questionBudgetRemaining: Math.max(0, 3 - usedQuestions),
    })

    for (const update of decision.playerUpdates) {
      await appendSystemMessage(client, session.id, 'system_update', update, { nextAction: decision.nextAction })
    }

    if (decision.nextAction === 'research') {
      if (!decision.researchPlan) throw new Error('Progression research move is missing its research plan')
      await setState(client, session.id, 'researching', { topic: decision.researchPlan.topic })
      if (decision.playerUpdates.length === 0) {
        await appendSystemMessage(client, session.id, 'research_update', 'Gue mau cek beberapa hal dulu sebelum nentuin langkah berikutnya.', { topic: decision.researchPlan.topic })
      }
      const researched = await runExternalResearch(dependencies.provider, {
        playerId: input.playerId,
        date: input.date,
        plan: decision.researchPlan,
        worldContext: {
          goals: progressionMap.goals.map(node => ({ summary: node.summary, confidence: node.confidence })),
          proximalOutcomes: progressionMap.proximalOutcomes.map(node => ({ summary: node.summary, confidence: node.confidence })),
          bottlenecks: progressionMap.bottlenecks.map(node => ({ summary: node.summary, confidence: node.confidence })),
          opportunities: progressionMap.opportunities.map(node => ({ summary: node.summary, confidence: node.confidence })),
          uncertainties: progressionMap.uncertainties,
        },
      })
      await persistResearch(client, session.id, decision.researchPlan, researched.result, researched.response)
      await appendSystemMessage(client, session.id, 'research_update', 'Gue udah cek bukti dari luar. Sekarang gue bandingin itu sama kondisi lo.', {
        topic: decision.researchPlan.topic,
        sourceCount: researched.result.sources.length,
      })
      research = await loadResearch(client, session.id)
      continue
    }

    if (decision.nextAction === 'ask') {
      if (usedQuestions >= 3) throw new Error('Progression move exceeded bounded clarification budget')
      await createQuestion(client, session.id, decision)
      // worker-v2 already maps this evidence phrase to the canonical insufficient_context terminal state.
      // The actual player-facing question lives in progression_questions; no raw model error reaches UI.
      throw new Error('evidence-backed player signals require one material clarification before a progression target')
    }

    if (decision.nextAction === 'decide' || decision.nextAction === 'wait') {
      const targetDecision = noInterventionDecision(decision)
      await appendSystemMessage(
        client,
        session.id,
        decision.nextAction === 'decide' ? 'decision' : 'wait',
        decision.nextAction === 'decide' ? decision.conclusion! : decision.waitFor!,
        { whyNow: decision.whyNow, criticalSignalIds: decision.criticalSignalIds },
      )
      await setState(client, session.id, 'waiting', { nextAction: decision.nextAction })
      return dependencies.store.persistProgressionTarget({
        playerId: input.playerId,
        date: input.date,
        progressionMapId: progressionMap.id,
        playerResponseModelId: playerResponseModel?.id,
        dailyContextId: base.dailyContext.id,
        decision: targetDecision,
        audit: auditFrom(response, PROGRESSION_MOVE_SCHEMA_VERSION),
      })
    }

    if (!decision.target) throw new Error('QUEST progression move is missing a Progression Target')
    await appendSystemMessage(client, session.id, 'decision', decision.target.summary, {
      whyNow: decision.whyNow,
      criticalSignalIds: decision.criticalSignalIds,
    })
    await setState(client, session.id, 'deciding', { nextAction: 'quest' })
    return dependencies.store.persistProgressionTarget({
      playerId: input.playerId,
      date: input.date,
      progressionMapId: progressionMap.id,
      playerResponseModelId: playerResponseModel?.id,
      dailyContextId: base.dailyContext.id,
      decision: decision.target,
      audit: auditFrom(response, PROGRESSION_MOVE_SCHEMA_VERSION),
    })
  }

  throw new Error('Progression move did not converge within bounded research passes')
}
