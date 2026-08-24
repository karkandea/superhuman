'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

const S = { bg:'#0c0f14', panel:'#13171f', line:'#232a35', ink:'#ECEAE3', muted:'#7e8795', muted2:'#596270', amber:'#f6b24b', gold:'#ffd488' } as const

type SessionRow = {
  id: string
  title: string
  kind: string
  state: string
  status: string
  opened_at: string
  closed_at: string | null
}

function dateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('id-ID', { day:'numeric', month:'short', year:'numeric' })
}

function stateLabel(value: string) {
  if (value === 'quest_ready') return 'Quest siap'
  if (value === 'need_clarification') return 'Butuh jawaban'
  if (value === 'researching') return 'Research'
  if (value === 'deciding') return 'Menentukan arah'
  if (value === 'waiting') return 'Observing'
  if (value === 'stopped') return 'Terhenti'
  return 'Memahami'
}

export default function ProgressionSessionsPage() {
  const params = useParams<{ username:string }>()
  const router = useRouter()
  const username = decodeURIComponent(String(params.username))
  const [sessions,setSessions] = useState<SessionRow[]>([])
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState(false)

  useEffect(() => {
    let cancelled=false
    async function load() {
      const { data:user } = await supabase.from('users').select('id').eq('name',username).single()
      if (!user) { router.push('/'); return }
      const { data,error:queryError } = await supabase
        .from('progression_sessions')
        .select('id,title,kind,state,status,opened_at,closed_at')
        .eq('user_id',user.id)
        .order('opened_at',{ ascending:false })
        .limit(60)
      if (queryError) throw queryError
      if (!cancelled) { setSessions((data ?? []) as SessionRow[]); setLoading(false) }
    }
    void load().catch(() => { if (!cancelled) { setError(true); setLoading(false) } })
    return () => { cancelled=true }
  },[router,username])

  return (
    <div style={{ minHeight:'100dvh',background:S.bg,color:S.ink,fontFamily:'"IBM Plex Sans", sans-serif' }}>
      <main style={{ maxWidth:620,margin:'0 auto',padding:'29px 18px 110px' }}>
        <Link href={`/${encodeURIComponent(username)}/history`} style={{ color:S.muted,textDecoration:'none',fontFamily:'"IBM Plex Mono", monospace',fontSize:8.5,fontWeight:700 }}>← PROGRESSION</Link>
        <div style={{ marginTop:20,fontFamily:'"IBM Plex Mono", monospace',fontSize:9,letterSpacing:'.14em',color:S.amber }}>PROGRESSION EPISODES</div>
        <h1 style={{ margin:'7px 0 0',fontFamily:'"Space Grotesk", sans-serif',fontSize:'clamp(34px,9vw,46px)',lineHeight:1,letterSpacing:'-.045em' }}>Perjalanan lo</h1>
        <p style={{ margin:'10px 0 0',color:S.muted,fontSize:12.5,lineHeight:1.55 }}>Bukan log database. Ini chapter saat System memahami sesuatu, mengubah arah, atau memilih next move.</p>

        <section style={{ marginTop:28,borderTop:`1px solid ${S.line}` }}>
          {loading ? <div style={{ padding:'20px 0',color:S.muted,fontSize:12 }}>Membaca episode…</div> : error ? (
            <div style={{ padding:'20px 0',color:S.muted,fontSize:12 }}>Riwayat belum bisa dibaca sekarang.</div>
          ) : sessions.length===0 ? (
            <div style={{ padding:'24px 0',color:S.muted,fontSize:12.5,lineHeight:1.6 }}>Belum ada episode. Episode pertama mulai saat System masuk ke progression decision pertama.</div>
          ) : sessions.map(session => (
            <Link key={session.id} href={`/${encodeURIComponent(username)}/history/sessions/${session.id}`} style={{ display:'block',textDecoration:'none',padding:'17px 0',borderBottom:`1px solid ${S.line}`,color:S.ink }}>
              <div style={{ display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:14 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ color:S.muted2,fontFamily:'"IBM Plex Mono", monospace',fontSize:8,letterSpacing:'.09em' }}>{dateLabel(session.opened_at)}</div>
                  <div style={{ marginTop:5,fontFamily:'"Space Grotesk", sans-serif',fontSize:18,fontWeight:650,letterSpacing:'-.02em' }}>{session.title}</div>
                  <div style={{ marginTop:5,color:S.muted,fontSize:11.5 }}>{stateLabel(session.state)}{session.status==='active' ? ' · aktif' : ''}</div>
                </div>
                <span style={{ color:S.gold,fontFamily:'"IBM Plex Mono", monospace',fontSize:12 }}>→</span>
              </div>
            </Link>
          ))}
        </section>
      </main>
    </div>
  )
}
