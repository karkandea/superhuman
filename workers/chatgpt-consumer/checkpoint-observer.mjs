const stageStarts = new Map()
const activeStage = new Map()

const START_STATUSES = new Set(['checking', 'waiting', 'start'])
const TERMINAL_STATUSES = new Set(['ready', 'verified', 'accepted', 'failed'])
const originalStdoutWrite = process.stdout.write.bind(process.stdout)
const originalStderrWrite = process.stderr.write.bind(process.stderr)

function nowMs() {
  return Date.now()
}

function checkpointKey(requestId, stage) {
  return `${requestId || 'unknown'}:${stage}`
}

function parseCheckpoint(line) {
  if (!line.includes('[worker-checkpoint]')) return null
  const requestId = line.match(/\brequestId=([^\s]+)/)?.[1] || 'unknown'
  const stage = line.match(/\bstage=([^\s]+)/)?.[1]
  const status = line.match(/\bstatus=([^\s]+)/)?.[1]
  if (!stage || !status) return null
  return { requestId, stage, status }
}

function emitDuration({ requestId, stage, status }, endedAt = nowMs()) {
  const key = checkpointKey(requestId, stage)
  const startedAt = stageStarts.get(key)
  if (startedAt == null) return
  const durationMs = Math.max(0, endedAt - startedAt)
  stageStarts.delete(key)
  if (activeStage.get(requestId) === stage) activeStage.delete(requestId)
  originalStdoutWrite(`[worker-step] requestId=${requestId} stage=${stage} status=${status} durationMs=${durationMs}\n`)
}

function observeCheckpoint(text) {
  for (const line of String(text).split('\n')) {
    const parsed = parseCheckpoint(line)
    if (!parsed) continue
    const key = checkpointKey(parsed.requestId, parsed.stage)
    if (START_STATUSES.has(parsed.status)) {
      if (!stageStarts.has(key)) stageStarts.set(key, nowMs())
      activeStage.set(parsed.requestId, parsed.stage)
      continue
    }
    if (TERMINAL_STATUSES.has(parsed.status)) emitDuration(parsed)
  }
}

function observeFailure(text) {
  for (const line of String(text).split('\n')) {
    const requestId = line.match(/\[requestId=([^\]]+)\]/)?.[1]
    if (!requestId) continue
    const stage = activeStage.get(requestId)
    if (!stage) continue
    const code = line.match(/\b(?:retry scheduled|failed|blocked):\s*([^:\s]+)/)?.[1] || 'unknown'
    const key = checkpointKey(requestId, stage)
    const startedAt = stageStarts.get(key)
    const durationMs = startedAt == null ? 0 : Math.max(0, nowMs() - startedAt)
    stageStarts.delete(key)
    activeStage.delete(requestId)
    originalStderrWrite(`[worker-failure] requestId=${requestId} stage=${stage} code=${code} durationMs=${durationMs}\n`)
  }
}

process.stdout.write = function observedStdout(chunk, encoding, callback) {
  observeCheckpoint(chunk)
  return originalStdoutWrite(chunk, encoding, callback)
}

process.stderr.write = function observedStderr(chunk, encoding, callback) {
  observeFailure(chunk)
  return originalStderrWrite(chunk, encoding, callback)
}

process.on('exit', () => {
  for (const [requestId, stage] of activeStage.entries()) {
    const startedAt = stageStarts.get(checkpointKey(requestId, stage))
    const durationMs = startedAt == null ? 0 : Math.max(0, nowMs() - startedAt)
    originalStderrWrite(`[worker-failure] requestId=${requestId} stage=${stage} code=process_exit durationMs=${durationMs}\n`)
  }
})
