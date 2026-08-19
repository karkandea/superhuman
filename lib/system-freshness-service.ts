import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveSystemFreshness, type SystemFreshnessView } from './system-ux'

export interface SystemFreshnessSnapshot extends SystemFreshnessView {
  latestKnowledgeId: string | null
  latestJobId: string | null
  latestJobStatus: string | null
  latestAssessmentDisposition: 'no_change' | 'suggest' | 'auto_interrupt' | null
  latestInterruptStatus: 'suggested' | 'applied' | null
  errorCode: string | null
}

interface KnowledgeRow {
  id: string
  created_at: string
  processing_status: string
  materiality_status: string
  processing_error: string | null
}

interface JobRow {
  id: string
  status: string
  updated_at: string
  completed_at: string | null
  error_code: string | null
  error_message: string | null
}

interface BriefRow {
  version: number
  created_at: string
}

interface AssessmentRow {
  id: string
  disposition: 'no_change' | 'suggest' | 'auto_interrupt'
}

export async function loadSystemFreshness(
  client: SupabaseClient,
  playerId: string,
  targetDate: string,
): Promise<SystemFreshnessSnapshot> {
  if (!playerId) throw new Error('playerId is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('targetDate must use YYYY-MM-DD')

  const [knowledgeResult, jobResult, briefResult] = await Promise.all([
    client
      .from('knowledge_entries')
      .select('id,created_at,processing_status,materiality_status,processing_error')
      .eq('user_id', playerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from('ai_inference_jobs')
      .select('id,status,updated_at,completed_at,error_code,error_message')
      .eq('user_id', playerId)
      .eq('operation', 'progression_cycle')
      .eq('target_date', targetDate)
      .maybeSingle(),
    client
      .from('player_briefs')
      .select('version,created_at')
      .eq('user_id', playerId)
      .eq('is_current', true)
      .maybeSingle(),
  ])

  if (knowledgeResult.error) throw new Error(`load latest update: ${knowledgeResult.error.message}`)
  if (jobResult.error) throw new Error(`load System processing: ${jobResult.error.message}`)
  if (briefResult.error) throw new Error(`load System understanding: ${briefResult.error.message}`)

  const latestKnowledge = knowledgeResult.data as KnowledgeRow | null
  const latestJob = jobResult.data as JobRow | null
  const currentBrief = briefResult.data as BriefRow | null
  let assessment: AssessmentRow | null = null
  let interruptStatus: 'suggested' | 'applied' | null = null

  if (latestKnowledge) {
    const { data, error } = await client
      .from('materiality_assessments')
      .select('id,disposition')
      .eq('user_id', playerId)
      .overlaps('knowledge_entry_ids', [latestKnowledge.id])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`load latest System decision: ${error.message}`)
    assessment = data as AssessmentRow | null
  }

  if (assessment) {
    const { data, error } = await client
      .from('quest_interrupts')
      .select('status')
      .eq('user_id', playerId)
      .eq('assessment_id', assessment.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`load latest System Interrupt: ${error.message}`)
    if (data?.status === 'suggested' || data?.status === 'applied') interruptStatus = data.status
  }

  const view = deriveSystemFreshness({
    latestKnowledgeCreatedAt: latestKnowledge?.created_at,
    latestKnowledgeProcessingStatus: latestKnowledge?.processing_status,
    latestKnowledgeMaterialityStatus: latestKnowledge?.materiality_status,
    latestKnowledgeProcessingError: latestKnowledge?.processing_error,
    latestJobStatus: latestJob?.status,
    latestJobUpdatedAt: latestJob?.updated_at,
    latestJobCompletedAt: latestJob?.completed_at,
    latestJobErrorCode: latestJob?.error_code,
    latestJobErrorMessage: latestJob?.error_message,
    latestAssessmentDisposition: assessment?.disposition ?? null,
    latestInterruptStatus: interruptStatus,
    currentBriefCreatedAt: currentBrief?.created_at,
    currentBriefVersion: currentBrief?.version,
  })

  return {
    ...view,
    latestKnowledgeId: latestKnowledge?.id ?? null,
    latestJobId: latestJob?.id ?? null,
    latestJobStatus: latestJob?.status ?? null,
    latestAssessmentDisposition: assessment?.disposition ?? null,
    latestInterruptStatus: interruptStatus,
    errorCode: latestJob?.error_code ?? null,
  }
}
