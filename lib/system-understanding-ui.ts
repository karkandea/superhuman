type UnknownRecord = Record<string, unknown>

export type UnderstandingStageId = 'starting_point' | 'context_formed' | 'patterns_visible'

export interface UnderstandingStage {
  id: UnderstandingStageId
  label: string
  title: string
  description: string
  depth: 1 | 2 | 3
}

export interface UnderstandingPictureItem {
  id: string
  label: string
  summary: string
}

export interface UnderstandingChangeItem {
  id: string
  label: string
  summary: string
}

const SECTION_LABELS: Record<string, string> = {
  goals: 'Arah lo',
  priorities: 'Prioritas lo',
  obstacles: 'Hambatan lo',
  constraints: 'Kondisi yang perlu dijaga',
  opportunities: 'Peluang yang kebaca',
  preferences: 'Cara yang lebih cocok buat lo',
  relationships: 'Konteks hubungan',
  events: 'Hal yang berubah',
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function sortedSummaries(value: unknown, priorityField: 'priority' | 'importance' | 'confidence') {
  return asArray(value)
    .map(item => asRecord(item))
    .filter(item => text(item.summary))
    .sort((left, right) => number(right[priorityField]) - number(left[priorityField]) || number(right.confidence) - number(left.confidence))
}

function sortedPatterns(value: unknown) {
  return asArray(value)
    .map(item => asRecord(item))
    .filter(item => text(item.observation))
    .sort((left, right) => number(right.confidence) - number(left.confidence))
}

function modelPatternCount(modelValue: unknown) {
  const model = asRecord(modelValue)
  return ['executionPatterns', 'difficultyCalibration', 'receptivityPatterns', 'strategyEvidence']
    .reduce((sum, key) => sum + asArray(model[key]).length, 0)
}

function strategicNodeCount(mapValue: unknown) {
  const map = asRecord(mapValue)
  return ['goals', 'proximalOutcomes', 'bottlenecks', 'opportunities']
    .reduce((sum, key) => sum + asArray(map[key]).length, 0)
}

export function deriveUnderstandingStage(input: {
  playerBrief?: unknown
  progressionMap?: unknown
  responseModel?: unknown
}): UnderstandingStage {
  const brief = asRecord(input.playerBrief)
  const understandingIds = asArray(brief.activeUnderstandingIds)
  const hasBrief = understandingIds.length > 0 || asArray(brief.highlights).length > 0
  const hasStrategicContext = strategicNodeCount(input.progressionMap) > 0
  const hasBehavioralPatterns = modelPatternCount(input.responseModel) > 0

  if (hasBehavioralPatterns) {
    return {
      id: 'patterns_visible',
      label: 'PLAYER UNDERSTANDING',
      title: 'Pola mulai terlihat',
      description: 'System sudah punya konteks hidup lo dan mulai belajar dari cara lo merespons quest.',
      depth: 3,
    }
  }

  if (hasStrategicContext) {
    return {
      id: 'context_formed',
      label: 'PLAYER UNDERSTANDING',
      title: 'Konteks terbentuk',
      description: 'Arah dan hambatan utama lo sudah cukup kebaca. System masih belajar dari apa yang terjadi setelah lo jalanin.',
      depth: 2,
    }
  }

  return {
    id: 'starting_point',
    label: 'PLAYER UNDERSTANDING',
    title: hasBrief ? 'Titik awal terbentuk' : 'Titik awal',
    description: hasBrief
      ? 'System sudah punya gambaran dasar dan akan mempertajamnya dari update serta hasil nyata lo.'
      : 'System lagi membangun konteks dasar dari yang lo ceritain.',
    depth: 1,
  }
}

function firstBriefSummary(briefValue: unknown, sectionKeys: string[]) {
  const brief = asRecord(briefValue)
  const sections = asRecord(brief.sections)
  for (const key of sectionKeys) {
    const item = asRecord(asArray(sections[key])[0])
    const summary = text(item.summary)
    if (summary) return summary
  }
  return ''
}

function firstModelPattern(modelValue: unknown) {
  const model = asRecord(modelValue)
  const candidates = [
    ...sortedPatterns(model.executionPatterns),
    ...sortedPatterns(model.receptivityPatterns),
    ...sortedPatterns(model.difficultyCalibration),
  ].sort((left, right) => number(right.confidence) - number(left.confidence))
  return text(candidates[0]?.observation)
}

export function extractCurrentPicture(input: {
  playerBrief?: unknown
  progressionMap?: unknown
  responseModel?: unknown
}): UnderstandingPictureItem[] {
  const map = asRecord(input.progressionMap)
  const items: UnderstandingPictureItem[] = []

  const goal = text(sortedSummaries(map.goals, 'priority')[0]?.summary)
    || firstBriefSummary(input.playerBrief, ['goals', 'priorities'])
  if (goal) items.push({ id: 'direction', label: 'Yang sedang lo kejar', summary: goal })

  const bottleneck = text(sortedSummaries(map.bottlenecks, 'importance')[0]?.summary)
    || firstBriefSummary(input.playerBrief, ['obstacles', 'constraints'])
  if (bottleneck) items.push({ id: 'bottleneck', label: 'Yang paling menghambat', summary: bottleneck })

  const opportunity = text(sortedSummaries(map.opportunities, 'importance')[0]?.summary)
    || firstBriefSummary(input.playerBrief, ['opportunities'])
  if (opportunity) items.push({ id: 'opportunity', label: 'Peluang yang kebaca', summary: opportunity })

  const pattern = firstModelPattern(input.responseModel)
  if (pattern) items.push({ id: 'pattern', label: 'Pola yang mulai terlihat', summary: pattern })

  return items.slice(0, 4)
}

function flattenBriefSections(briefValue: unknown) {
  const brief = asRecord(briefValue)
  const sections = asRecord(brief.sections)
  const rows: Array<{ id: string; label: string; summary: string }> = []

  for (const [sectionKey, sectionValue] of Object.entries(sections)) {
    for (const rawItem of asArray(sectionValue)) {
      const item = asRecord(rawItem)
      const id = text(item.id)
      const summary = text(item.summary)
      if (!id || !summary) continue
      rows.push({ id, label: SECTION_LABELS[sectionKey] ?? 'Yang System pahami', summary })
    }
  }

  return rows
}

export function extractUnderstandingChanges(currentBriefValue: unknown, previousBriefValue?: unknown): UnderstandingChangeItem[] {
  if (!previousBriefValue) return []
  const current = flattenBriefSections(currentBriefValue)
  const previousById = new Map(flattenBriefSections(previousBriefValue).map(item => [item.id, item]))
  const changes: UnderstandingChangeItem[] = []

  for (const item of current) {
    const previous = previousById.get(item.id)
    if (!previous) {
      changes.push({ id: `new-${item.id}`, label: 'Baru dipahami', summary: item.summary })
      continue
    }
    if (previous.summary !== item.summary) {
      changes.push({ id: `updated-${item.id}`, label: 'Pemahaman diperbarui', summary: item.summary })
    }
  }

  return changes.slice(0, 3)
}
