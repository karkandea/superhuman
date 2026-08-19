export const DAILY_CONTEXT_MODES = ['normal', 'context'] as const
export const DAILY_CONTEXT_MAX_BYTES = 4 * 1024

export type DailyContextMode = (typeof DAILY_CONTEXT_MODES)[number]

export interface DailyContextSnapshot {
  id: string
  userId: string
  contextDate: string
  mode: DailyContextMode
  text: string
  createdAt: string
  updatedAt: string
}

export interface DailyContextInput {
  mode: DailyContextMode
  text?: string | null
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

export function normalizeDailyContextInput(input: DailyContextInput): { mode: DailyContextMode; text: string } {
  if (!DAILY_CONTEXT_MODES.includes(input.mode)) throw new Error('Unsupported Daily Context mode')

  const text = (input.text ?? '').trim()
  if (input.mode === 'normal' && text) {
    throw new Error('Normal-day check-in must not include custom context')
  }
  if (input.mode === 'context' && !text) {
    throw new Error('Tell the System what is different today')
  }
  if (byteLength(text) > DAILY_CONTEXT_MAX_BYTES) {
    throw new Error('Today context is too long. Keep it under 4 KB.')
  }

  return { mode: input.mode, text }
}

export function dailyContextSummary(context: DailyContextSnapshot | null | undefined) {
  if (!context) return 'Daily Context has not been confirmed yet.'
  if (context.mode === 'normal') return 'Normal day — no unusual temporary constraints reported.'
  return context.text
}
