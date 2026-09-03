'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

type OperatorTurn = {
  id: string
  jobId: string
  userId: string
  playerName: string
  targetDate: string
  operation: string
  schemaVersion: string
  requestId: string
  prompt: string
  requiresWebSearch: boolean
  status: 'pending' | 'invalid'
  modelId?: string | null
  validationError?: string | null
  createdAt: string
  submittedAt?: string | null
  updatedAt: string
}

const S = {
  bg: '#0c0f14', panel: '#13171f', panel2: '#171c25', line: '#27303c', ink: '#eceae3',
  muted: '#8893a3', muted2: '#5d6877', amber: '#f6b24b', gold: '#ffd488', red: '#ee7889', green: '#76d39a',
} as const

export default function ManualInferenceOperatorPage() {
  const [token, setToken] = useState('')
  const [turns, setTurns] = useState<OperatorTurn[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [response, setResponse] = useState('')
  const [modelId, setModelId] = useState('chatgpt-manual')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const saved = window.sessionStorage.getItem('superhuman.operator.token') || ''
    if (saved) setToken(saved)
  }, [])

  useEffect(() => {
    if (token) window.sessionStorage.setItem('superhuman.operator.token', token)
  }, [token])

  const selected = useMemo(
    () => turns.find(turn => turn.id === selectedId) ?? turns[0] ?? null,
    [selectedId, turns],
  )

  useEffect(() => {
    if (!selectedId && turns[0]) setSelectedId(turns[0].id)
    if (selectedId && !turns.some(turn => turn.id === selectedId)) {
      setSelectedId(turns[0]?.id ?? null)
      setResponse('')
    }
  }, [selectedId, turns])

  const loadTurns = useCallback(async (quiet = false) => {
    if (!token.trim()) return
    if (!quiet) setLoading(true)
    setError(null)
    try {
      const result = await fetch('/api/operator/inference', {
        cache: 'no-store',
        headers: { 'x-superhuman-operator-token': token.trim() },
      })
      const body = await result.json() as { turns?: OperatorTurn[]; error?: string }
      if (!result.ok) throw new Error(body.error || `Operator queue request failed (${result.status})`)
      setTurns(body.turns ?? [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Operator queue failed to load')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!token.trim()) return
    void loadTurns()
    const timer = window.setInterval(() => { void loadTurns(true) }, 3000)
    return () => window.clearInterval(timer)
  }, [loadTurns, token])

  async function copyPrompt() {
    if (!selected) return
    await navigator.clipboard.writeText(selected.prompt)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  async function submitResponse() {
    if (!selected || !response.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await fetch('/api/operator/inference', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-superhuman-operator-token': token.trim(),
        },
        body: JSON.stringify({ turnId: selected.id, response, modelId }),
      })
      const body = await result.json() as { error?: string }
      if (!result.ok) throw new Error(body.error || `Submit failed (${result.status})`)
      setResponse('')
      await loadTurns(true)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Response could not be submitted')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main style={{ minHeight: '100dvh', background: S.bg, color: S.ink, padding: '28px 18px 80px', fontFamily: '"IBM Plex Mono", monospace' }}>
      <div style={{ width: 'min(1180px, 100%)', margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'end', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 20 }}>
          <div>
            <div style={{ color: S.amber, fontSize: 10, letterSpacing: '.12em', fontWeight: 800 }}>SUPERHUMAN / OPERATOR</div>
            <h1 style={{ margin: '8px 0 4px', fontSize: 24, lineHeight: 1.2 }}>Manual Relay Console</h1>
            <div style={{ color: S.muted, fontSize: 11 }}>Copy prompt → run it in ChatGPT → paste the structured response → submit.</div>
          </div>
          <div style={{ width: 'min(420px, 100%)' }}>
            <label style={{ display: 'block', color: S.muted, fontSize: 9, marginBottom: 6, letterSpacing: '.08em' }}>OPERATOR TOKEN</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                value={token}
                onChange={event => setToken(event.target.value)}
                placeholder="SUPERHUMAN_OPERATOR_TOKEN"
                style={{ flex: 1, minWidth: 0, border: `1px solid ${S.line}`, background: S.panel, color: S.ink, borderRadius: 9, padding: '10px 11px', outline: 'none', fontFamily: 'inherit', fontSize: 11 }}
              />
              <button type="button" onClick={() => { void loadTurns() }} disabled={!token.trim() || loading} style={buttonStyle(false)}>
                {loading ? 'LOADING…' : 'LOAD'}
              </button>
            </div>
          </div>
        </div>

        {error && <div role="alert" style={{ marginBottom: 14, border: '1px solid #5a2d38', background: '#1a1116', color: S.red, borderRadius: 10, padding: '10px 12px', fontSize: 10 }}>{error}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, .72fr) minmax(0, 1.8fr)', gap: 14, alignItems: 'start' }}>
          <section style={{ border: `1px solid ${S.line}`, background: S.panel, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '11px 12px', borderBottom: `1px solid ${S.line}`, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 800 }}>PENDING TURNS</span>
              <span style={{ color: turns.length ? S.gold : S.muted2, fontSize: 10 }}>{turns.length}</span>
            </div>
            {turns.length === 0 ? (
              <div style={{ padding: 18, color: S.muted, fontSize: 10, lineHeight: 1.6 }}>
                {token.trim() ? 'No inference turn is waiting for manual relay.' : 'Enter the operator token to load the queue.'}
              </div>
            ) : turns.map(turn => {
              const active = selected?.id === turn.id
              return (
                <button
                  key={turn.id}
                  type="button"
                  onClick={() => { setSelectedId(turn.id); setResponse(''); setCopied(false) }}
                  style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: `1px solid ${S.line}`, background: active ? S.panel2 : 'transparent', color: S.ink, padding: 12, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ color: S.gold, fontSize: 10, fontWeight: 800 }}>{turn.playerName}</span>
                    <span style={{ color: turn.status === 'invalid' ? S.red : S.muted2, fontSize: 8, textTransform: 'uppercase' }}>{turn.status}</span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 10, lineHeight: 1.35 }}>{turn.operation}</div>
                  <div style={{ marginTop: 5, color: S.muted2, fontSize: 8 }}>{turn.targetDate} · {turn.schemaVersion}</div>
                </button>
              )
            })}
          </section>

          <section style={{ border: `1px solid ${S.line}`, background: S.panel, borderRadius: 12, overflow: 'hidden' }}>
            {!selected ? (
              <div style={{ padding: 22, color: S.muted, fontSize: 10 }}>Select a pending inference turn.</div>
            ) : (
              <>
                <div style={{ padding: 14, borderBottom: `1px solid ${S.line}`, display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ color: S.gold, fontSize: 11, fontWeight: 800 }}>{selected.playerName} · {selected.operation}</div>
                    <div style={{ color: S.muted2, fontSize: 8, marginTop: 4 }}>{selected.requestId}</div>
                  </div>
                  {selected.requiresWebSearch && (
                    <div style={{ border: '1px solid #6c5730', background: '#211b10', color: S.gold, borderRadius: 99, padding: '6px 9px', fontSize: 8, fontWeight: 800 }}>WEB SEARCH REQUIRED</div>
                  )}
                </div>

                {selected.validationError && (
                  <div style={{ margin: 14, marginBottom: 0, border: '1px solid #5a2d38', background: '#1a1116', color: S.red, borderRadius: 9, padding: '10px 11px', fontSize: 9, lineHeight: 1.5 }}>
                    Previous response was rejected: {selected.validationError}
                  </div>
                )}

                <div style={{ padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                    <label style={labelStyle}>PROMPT TO CHATGPT</label>
                    <button type="button" onClick={() => { void copyPrompt() }} style={buttonStyle(true)}>{copied ? 'COPIED' : 'COPY PROMPT'}</button>
                  </div>
                  <textarea readOnly value={selected.prompt} style={{ ...textareaStyle, minHeight: 300, color: '#cbd3df' }} />

                  <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 210px', gap: 10 }}>
                    <div>
                      <label style={labelStyle}>PASTE CHATGPT RESPONSE</label>
                      <textarea
                        value={response}
                        onChange={event => setResponse(event.target.value)}
                        placeholder="Paste the complete ChatGPT response here…"
                        style={{ ...textareaStyle, minHeight: 220, marginTop: 7 }}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>MODEL LABEL</label>
                      <input
                        value={modelId}
                        onChange={event => setModelId(event.target.value)}
                        style={{ width: '100%', boxSizing: 'border-box', marginTop: 7, border: `1px solid ${S.line}`, background: '#0f1319', color: S.ink, borderRadius: 9, padding: '10px 11px', outline: 'none', fontFamily: 'inherit', fontSize: 10 }}
                      />
                      <button
                        type="button"
                        onClick={() => { void submitResponse() }}
                        disabled={!response.trim() || submitting}
                        style={{ ...buttonStyle(false), width: '100%', marginTop: 10, minHeight: 42, background: response.trim() ? S.amber : '#333a45', color: response.trim() ? '#16120a' : S.muted }}
                      >
                        {submitting ? 'SUBMITTING…' : 'SUBMIT & CONTINUE'}
                      </button>
                      <div style={{ marginTop: 9, color: S.muted2, fontSize: 8, lineHeight: 1.5 }}>
                        The core validates the envelope on resume. Invalid output returns to this same turn with the validation error shown above.
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}

const labelStyle = { display: 'block', color: S.muted, fontSize: 8, fontWeight: 800, letterSpacing: '.08em' } as const
const textareaStyle = { width: '100%', boxSizing: 'border-box', resize: 'vertical' as const, border: `1px solid ${S.line}`, background: '#0f1319', color: S.ink, borderRadius: 9, padding: 11, outline: 'none', fontFamily: '"IBM Plex Mono", monospace', fontSize: 9.5, lineHeight: 1.55 }

function buttonStyle(subtle: boolean) {
  return {
    border: `1px solid ${subtle ? S.line : '#4a515c'}`,
    background: subtle ? '#171c25' : '#272e38',
    color: subtle ? S.gold : S.ink,
    borderRadius: 8,
    padding: '8px 10px',
    fontFamily: '"IBM Plex Mono", monospace',
    fontSize: 8.5,
    fontWeight: 800,
    letterSpacing: '.04em',
    cursor: 'pointer',
  } as const
}
