import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function serviceKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

function operatorToken() {
  return process.env.SUPERHUMAN_OPERATOR_TOKEN || ''
}

function isAuthorized(request: Request) {
  const expected = operatorToken()
  const supplied = request.headers.get('x-superhuman-operator-token') || ''
  return Boolean(expected) && supplied.length === expected.length && supplied === expected
}

function serverClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = serviceKey()
  if (!url || !key) throw new Error('Server Supabase configuration is missing')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function unauthorized() {
  return NextResponse.json({ error: 'Operator authorization required' }, { status: 401 })
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized()

  try {
    const client = serverClient()
    const { data: turns, error } = await client
      .from('manual_inference_turns')
      .select('id,job_id,user_id,target_date,operation,schema_version,request_id,prompt,attachments,requires_web_search,status,model_id,validation_error,created_at,submitted_at,updated_at')
      .in('status', ['pending', 'invalid'])
      .order('created_at', { ascending: true })
      .limit(50)
    if (error) throw new Error(`load manual inference turns: ${error.message}`)

    const userIds = [...new Set((turns ?? []).map(turn => String(turn.user_id)))]
    const userNameById = new Map<string, string>()
    if (userIds.length > 0) {
      const { data: users, error: userError } = await client
        .from('users')
        .select('id,name')
        .in('id', userIds)
      if (userError) throw new Error(`load operator player labels: ${userError.message}`)
      for (const user of users ?? []) userNameById.set(String(user.id), String(user.name || ''))
    }

    return NextResponse.json({
      turns: (turns ?? []).map(turn => ({
        id: turn.id,
        jobId: turn.job_id,
        userId: turn.user_id,
        playerName: userNameById.get(String(turn.user_id)) || String(turn.user_id),
        targetDate: turn.target_date,
        operation: turn.operation,
        schemaVersion: turn.schema_version,
        requestId: turn.request_id,
        prompt: turn.prompt,
        attachments: Array.isArray(turn.attachments) ? turn.attachments : [],
        requiresWebSearch: Boolean(turn.requires_web_search),
        status: turn.status,
        modelId: turn.model_id,
        validationError: turn.validation_error,
        createdAt: turn.created_at,
        submittedAt: turn.submitted_at,
        updatedAt: turn.updated_at,
      })),
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Operator queue failed to load' },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized()

  try {
    const body = await request.json() as { turnId?: unknown; response?: unknown; modelId?: unknown }
    const turnId = typeof body.turnId === 'string' ? body.turnId.trim() : ''
    const rawResponse = typeof body.response === 'string' ? body.response.trim() : ''
    const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : ''

    if (!turnId) return NextResponse.json({ error: 'turnId is required' }, { status: 400 })
    if (!rawResponse) return NextResponse.json({ error: 'ChatGPT response is required' }, { status: 400 })

    const client = serverClient()
    const now = new Date().toISOString()
    const { data: turn, error: turnError } = await client
      .from('manual_inference_turns')
      .select('id,status,job_id')
      .eq('id', turnId)
      .single()
    if (turnError) throw new Error(`load manual inference turn: ${turnError.message}`)
    if (!['pending', 'invalid'].includes(String(turn.status))) {
      return NextResponse.json({ error: `Turn is already ${turn.status}` }, { status: 409 })
    }

    const { error: updateError } = await client
      .from('manual_inference_turns')
      .update({
        raw_response: rawResponse,
        model_id: modelId || 'chatgpt-manual',
        status: 'submitted',
        validation_error: null,
        submitted_at: now,
        updated_at: now,
      })
      .eq('id', turnId)
      .in('status', ['pending', 'invalid'])
    if (updateError) throw new Error(`submit manual inference response: ${updateError.message}`)

    const { data: resumed, error: resumeError } = await client.rpc('resume_ai_inference_job_from_operator', {
      p_turn_id: turnId,
    })
    if (resumeError) throw new Error(`resume inference job: ${resumeError.message}`)

    return NextResponse.json({ ok: true, turnId, job: Array.isArray(resumed) ? resumed[0] ?? null : resumed })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Manual inference response could not be submitted' },
      { status: 500 },
    )
  }
}
