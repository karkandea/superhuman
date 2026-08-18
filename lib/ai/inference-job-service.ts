import type { SupabaseClient } from '@supabase/supabase-js'

export type AiInferenceJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked_auth' | 'paused_rate_limit'

export interface AiInferenceJob {
  id: string
  userId: string
  operation: 'progression_cycle'
  targetDate: string
  status: AiInferenceJobStatus
  attemptCount: number
  maxAttempts: number
  errorCode?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

function mapJob(row: Record<string, unknown>): AiInferenceJob {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    operation: 'progression_cycle',
    targetDate: String(row.target_date),
    status: row.status as AiInferenceJobStatus,
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown> | undefined) ?? null
  if (data && typeof data === 'object') return data as Record<string, unknown>
  return null
}

const JOB_COLUMNS = 'id,user_id,operation,target_date,status,attempt_count,max_attempts,error_code,error_message,created_at,updated_at'

export async function requestDailyQuestGeneration(client: SupabaseClient, targetDate: string): Promise<AiInferenceJob> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('targetDate must use YYYY-MM-DD')
  const { data, error } = await client.rpc('request_progression_cycle', { p_target_date: targetDate })
  if (error) throw new Error(`request progression cycle: ${error.message}`)
  const row = firstRow(data)
  if (!row) throw new Error('request progression cycle returned no job')
  return mapJob(row)
}

export async function getAiInferenceJob(client: SupabaseClient, jobId: string): Promise<AiInferenceJob | null> {
  const { data, error } = await client
    .from('ai_inference_jobs')
    .select(JOB_COLUMNS)
    .eq('id', jobId)
    .maybeSingle()
  if (error) throw new Error(`load inference job: ${error.message}`)
  return data ? mapJob(data as Record<string, unknown>) : null
}

export async function getAiInferenceJobForDate(
  client: SupabaseClient,
  playerId: string,
  targetDate: string,
): Promise<AiInferenceJob | null> {
  if (!playerId) throw new Error('playerId is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('targetDate must use YYYY-MM-DD')

  const { data, error } = await client
    .from('ai_inference_jobs')
    .select(JOB_COLUMNS)
    .eq('user_id', playerId)
    .eq('operation', 'progression_cycle')
    .eq('target_date', targetDate)
    .maybeSingle()

  if (error) throw new Error(`load inference job for date: ${error.message}`)
  return data ? mapJob(data as Record<string, unknown>) : null
}
