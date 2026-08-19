export const SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS = ['txt', 'md', 'json'] as const
export type SupportedKnowledgeFileExtension = (typeof SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS)[number]

export const MAX_KNOWLEDGE_FILE_BYTES = 40 * 1024
export const MAX_KNOWLEDGE_TEXT_LENGTH = 50_000

export interface KnowledgeFileDescriptor {
  name: string
  size: number
}

export interface ValidatedKnowledgeFile {
  extension: SupportedKnowledgeFileExtension
  name: string
  size: number
}

export function getKnowledgeFileExtension(name: string): string {
  const clean = name.trim().toLowerCase()
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1) : ''
}

export function validateKnowledgeFileDescriptor(file: KnowledgeFileDescriptor): ValidatedKnowledgeFile {
  const name = file.name.trim()
  const extension = getKnowledgeFileExtension(name)

  if (!name) throw new Error('Choose a TXT, MD, or JSON file')
  if (!SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS.includes(extension as SupportedKnowledgeFileExtension)) {
    throw new Error('Only TXT, MD, and JSON files are supported')
  }
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('The selected file is empty')
  if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new Error(`Keep text files under ${Math.round(MAX_KNOWLEDGE_FILE_BYTES / 1024)} KB`)
  }

  return {
    extension: extension as SupportedKnowledgeFileExtension,
    name,
    size: file.size,
  }
}

export function composeKnowledgeText(message: string, fileText?: string, fileName?: string): string {
  const cleanMessage = message.trim()
  const cleanFileText = fileText?.trim() ?? ''
  let combined = cleanMessage

  if (cleanFileText) {
    combined = cleanMessage
      ? `${cleanMessage}\n\nAttached file — ${fileName ?? 'text file'}\n\n${cleanFileText}`
      : cleanFileText
  }

  if (!combined) throw new Error('Tell the System something or attach a file')
  if (combined.length > MAX_KNOWLEDGE_TEXT_LENGTH) {
    throw new Error('This update is too large. Shorten the text or upload a smaller file')
  }

  return combined
}

export type SystemFreshnessPhase =
  | 'empty'
  | 'saved'
  | 'collecting'
  | 'processing'
  | 'updated'
  | 'no_change'
  | 'interrupt'
  | 'failure'

export interface SystemFreshnessInput {
  latestKnowledgeCreatedAt?: string | null
  latestKnowledgeProcessingStatus?: string | null
  latestKnowledgeMaterialityStatus?: string | null
  latestKnowledgeProcessingError?: string | null
  latestJobStatus?: string | null
  latestJobUpdatedAt?: string | null
  latestJobCompletedAt?: string | null
  latestJobErrorCode?: string | null
  latestJobErrorMessage?: string | null
  latestAssessmentDisposition?: 'no_change' | 'suggest' | 'auto_interrupt' | null
  latestInterruptStatus?: 'suggested' | 'applied' | null
  currentBriefCreatedAt?: string | null
  currentBriefVersion?: number | null
}

export interface SystemFreshnessView {
  phase: SystemFreshnessPhase
  eyebrow: string
  title: string
  detail: string
  tone: 'quiet' | 'active' | 'warm' | 'danger'
  isBusy: boolean
  canRetry: boolean
  lastUpdateAt: string | null
  understandingUpdatedAt: string | null
  briefVersion: number | null
}

function timestamp(value?: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function laterDate(first?: string | null, second?: string | null): string | null {
  const firstTime = timestamp(first)
  const secondTime = timestamp(second)
  if (firstTime === null) return second ?? null
  if (secondTime === null) return first ?? null
  return firstTime >= secondTime ? first ?? null : second ?? null
}

export function deriveSystemFreshness(input: SystemFreshnessInput): SystemFreshnessView {
  const lastUpdateAt = input.latestKnowledgeCreatedAt ?? null
  const understandingUpdatedAt = laterDate(input.latestJobCompletedAt, input.currentBriefCreatedAt)
  const updateTime = timestamp(lastUpdateAt)
  const jobUpdatedTime = timestamp(input.latestJobUpdatedAt)
  const jobCompletedTime = timestamp(input.latestJobCompletedAt)
  const briefTime = timestamp(input.currentBriefCreatedAt)
  const jobIsForLatestUpdate = updateTime === null || (jobUpdatedTime !== null && jobUpdatedTime >= updateTime)
  const completedAfterUpdate = updateTime === null || (jobCompletedTime !== null && jobCompletedTime >= updateTime)
  const briefAfterUpdate = updateTime === null || (briefTime !== null && briefTime >= updateTime)

  const base = {
    lastUpdateAt,
    understandingUpdatedAt,
    briefVersion: input.currentBriefVersion ?? null,
  }

  if (!lastUpdateAt) {
    return {
      ...base,
      phase: 'empty',
      eyebrow: 'SYSTEM READY',
      title: input.currentBriefCreatedAt ? 'System understanding is ready.' : 'Tell the System what changed.',
      detail: input.currentBriefCreatedAt
        ? 'Daily Quest is driven by the understanding already saved for this player.'
        : 'Your first update gives the System real context for progression.',
      tone: 'quiet',
      isBusy: false,
      canRetry: false,
    }
  }

  const knowledgeFailed = input.latestKnowledgeProcessingStatus === 'failed'
  const jobFailed = jobIsForLatestUpdate && ['failed', 'blocked_auth', 'paused_rate_limit'].includes(input.latestJobStatus ?? '')
  if (knowledgeFailed || jobFailed) {
    return {
      ...base,
      phase: 'failure',
      eyebrow: 'PROCESSING INTERRUPTED',
      title: 'Your update is safe.',
      detail: 'System processing was interrupted. You do not need to enter the update again; retry processing when the System is ready.',
      tone: 'danger',
      isBusy: false,
      canRetry: true,
    }
  }

  if ((jobIsForLatestUpdate && input.latestJobStatus === 'running') || input.latestKnowledgeProcessingStatus === 'processing') {
    return {
      ...base,
      phase: 'processing',
      eyebrow: 'PROCESSING',
      title: 'System is updating its understanding…',
      detail: 'Today’s quests stay stable while the System decides whether the new context materially changes anything.',
      tone: 'active',
      isBusy: true,
      canRetry: false,
    }
  }

  if (jobIsForLatestUpdate && input.latestJobStatus === 'queued') {
    return {
      ...base,
      phase: 'collecting',
      eyebrow: 'COLLECTING UPDATES',
      title: 'Your update is safe.',
      detail: 'System is briefly grouping nearby updates, then it will refresh its understanding in one progression cycle.',
      tone: 'active',
      isBusy: true,
      canRetry: false,
    }
  }

  if (
    input.latestAssessmentDisposition === 'auto_interrupt' &&
    (input.latestInterruptStatus === 'applied' || input.latestInterruptStatus === 'suggested')
  ) {
    return {
      ...base,
      phase: 'interrupt',
      eyebrow: input.latestInterruptStatus === 'applied' ? 'SYSTEM INTERRUPT' : 'SYSTEM SUGGESTION',
      title: input.latestInterruptStatus === 'applied'
        ? 'New information changed today’s priority.'
        : 'A possible priority change needs your call.',
      detail: input.latestInterruptStatus === 'applied'
        ? 'The important change is shown with today’s quests instead of being silently reshuffled.'
        : 'Today stays unchanged until you apply the suggested adjustment.',
      tone: 'warm',
      isBusy: false,
      canRetry: false,
    }
  }

  if (input.latestAssessmentDisposition === 'suggest') {
    return {
      ...base,
      phase: 'interrupt',
      eyebrow: 'SYSTEM SUGGESTION',
      title: 'A possible priority change needs your call.',
      detail: 'Today stays unchanged unless you choose to apply the suggested adjustment.',
      tone: 'warm',
      isBusy: false,
      canRetry: false,
    }
  }

  if (
    input.latestAssessmentDisposition === 'no_change' &&
    (completedAfterUpdate || briefAfterUpdate || input.latestKnowledgeMaterialityStatus === 'assessed')
  ) {
    return {
      ...base,
      phase: 'no_change',
      eyebrow: 'UPDATED · QUESTS UNCHANGED',
      title: 'System understood the update.',
      detail: 'Nothing in the latest context was important enough to change today’s plan.',
      tone: 'warm',
      isBusy: false,
      canRetry: false,
    }
  }

  if (
    input.latestKnowledgeProcessingStatus === 'processed' &&
    input.latestKnowledgeMaterialityStatus === 'pending'
  ) {
    return {
      ...base,
      phase: 'processing',
      eyebrow: 'PROCESSING',
      title: 'System is checking today’s plan…',
      detail: 'The update has been understood. System is deciding whether today should stay the same.',
      tone: 'active',
      isBusy: true,
      canRetry: false,
    }
  }

  if (
    input.latestKnowledgeProcessingStatus === 'processed' &&
    (completedAfterUpdate || briefAfterUpdate || input.latestKnowledgeMaterialityStatus === 'not_required')
  ) {
    return {
      ...base,
      phase: 'updated',
      eyebrow: 'UPDATED',
      title: 'System understanding is current.',
      detail: 'The latest saved context has been processed and is available to future progression cycles.',
      tone: 'warm',
      isBusy: false,
      canRetry: false,
    }
  }

  return {
    ...base,
    phase: 'saved',
    eyebrow: 'SAVED',
    title: 'Your update is safe.',
    detail: 'It is already in Life Vault. System will collect nearby updates before it starts processing.',
    tone: 'quiet',
    isBusy: false,
    canRetry: false,
  }
}
