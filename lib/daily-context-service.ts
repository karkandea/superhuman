import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeDailyContextInput, type DailyContextInput, type DailyContextSnapshot } from './daily-context'

function mapDailyContext(row: Record<string, unknown>): DailyContextSnapshot {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    contextDate: String(row.context_date),
    mode: row.mode === 'normal' ? 'normal' : 'context',
    text: String(row.context_text ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export async function getDailyContextForDate(
  client: SupabaseClient,
  playerId: string,
  targetDate: string,
): Promise<DailyContextSnapshot | null> {
  if (!playerId) throw new Error('playerId is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('targetDate must use YYYY-MM-DD')

  // Today is System-owned: this idempotent RPC creates the normal default and
  // progression job when needed. Historical dates are a read-only no-op inside
  // the RPC, so the same service remains safe for history screens.
  const { error: ensureError } = await client.rpc('ensure_daily_progression', {
    p_target_date: targetDate,
  })
  if (ensureError) throw new Error(`ensure Daily Context: ${ensureError.message}`)

  const { data, error } = await client
    .from('daily_contexts')
    .select('id,user_id,context_date,mode,context_text,created_at,updated_at')
    .eq('user_id', playerId)
    .eq('context_date', targetDate)
    .maybeSingle()

  if (error) throw new Error(`load Daily Context: ${error.message}`)
  return data ? mapDailyContext(data as Record<string, unknown>) : null
}

export async function submitDailyContext(
  client: SupabaseClient,
  targetDate: string,
  input: DailyContextInput,
): Promise<DailyContextSnapshot> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('targetDate must use YYYY-MM-DD')
  const normalized = normalizeDailyContextInput(input)
  const { data, error } = await client.rpc('submit_daily_context', {
    p_target_date: targetDate,
    p_mode: normalized.mode,
    p_context_text: normalized.text || null,
  })
  if (error) throw new Error(`save Daily Context: ${error.message}`)

  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') throw new Error('save Daily Context returned no row')
  return mapDailyContext(row as Record<string, unknown>)
}
