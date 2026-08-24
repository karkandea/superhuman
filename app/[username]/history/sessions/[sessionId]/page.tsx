'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import ConversationBubble from '../../../conversation-bubble'

const S={bg:'#0c0f14',panel:'#13171f',line:'#232a35',ink:'#ECEAE3',muted:'#7e8795',amber:'#f6b24b',gold:'#ffd488'} as const

type SessionRow={id:string;user_id:string;title:string;kind:string;state:string;status:string;opened_at:string;closed_at:string|null}
type MessageRow={id:string;actor:'player'|'system';message_type:string;body:string;metadata:Record<string,unknown>;created_at:string}
type ResearchRow={id:string;topic:string;research_question:string;findings:string;sources:Array<{title?:string;url?:string;keyPoint?:string;publishedAt?:string}>;completed_at:string}

function moment(value:string){const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleString('id-ID',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}

export default function ProgressionSessionDetailPage(){
  const params=useParams<{username:string;sessionId:string}>();const router=useRouter();
  const username=decodeURIComponent(String(params.username));const sessionId=String(params.sessionId);
  const [session,setSession]=useState<SessionRow|null>(null);const [messages,setMessages]=useState<MessageRow[]>([]);const [research,setResearch]=useState<ResearchRow[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState(false)

  useEffect(()=>{let cancelled=false;async function load(){
    const {data:user}=await supabase.from('users').select('id').eq('name',username).single();if(!user){router.push('/');return}
    const [sessionResult,messageResult,researchResult]=await Promise.all([
      supabase.from('progression_sessions').select('id,user_id,title,kind,state,status,opened_at,closed_at').eq('id',sessionId).eq('user_id',user.id).maybeSingle(),
      supabase.from('progression_messages').select('id,actor,message_type,body,metadata,created_at').eq('session_id',sessionId).eq('user_id',user.id).order('created_at',{ascending:true}),
      supabase.from('progression_research').select('id,topic,research_question,findings,sources,completed_at').eq('session_id',sessionId).eq('user_id',user.id).order('completed_at',{ascending:true}),
    ])
    if(sessionResult.error||messageResult.error||researchResult.error)throw sessionResult.error||messageResult.error||researchResult.error
    if(!sessionResult.data){router.push(`/${encodeURIComponent(username)}/history/sessions`);return}
    if(!cancelled){setSession(sessionResult.data as SessionRow);setMessages((messageResult.data??[]) as MessageRow[]);setResearch((researchResult.data??[]) as ResearchRow[]);setLoading(false)}
  }void load().catch(()=>{if(!cancelled){setError(true);setLoading(false)}});return()=>{cancelled=true}},[router,sessionId,username])

  return <div style={{minHeight:'100dvh',background:S.bg,color:S.ink,fontFamily:'"IBM Plex Sans", sans-serif'}}><main style={{maxWidth:680,margin:'0 auto',padding:'29px 18px 110px'}}>
    <Link href={`/${encodeURIComponent(username)}/history/sessions`} style={{color:S.muted,textDecoration:'none',fontFamily:'"IBM Plex Mono", monospace',fontSize:8.5,fontWeight:700}}>← SEMUA EPISODE</Link>
    {loading?<div style={{marginTop:30,color:S.muted,fontSize:12}}>Membaca episode…</div>:error||!session?<div style={{marginTop:30,color:S.muted,fontSize:12}}>Episode belum bisa dibaca sekarang.</div>:<>
      <header style={{marginTop:20,paddingBottom:20,borderBottom:`1px solid ${S.line}`}}>
        <div style={{fontFamily:'"IBM Plex Mono", monospace',fontSize:8.5,letterSpacing:'.13em',color:S.amber}}>{session.status==='active'?'ACTIVE EPISODE':'CLOSED EPISODE'} · {moment(session.opened_at)}</div>
        <h1 style={{margin:'8px 0 0',fontFamily:'"Space Grotesk", sans-serif',fontSize:'clamp(32px,8vw,44px)',lineHeight:1,letterSpacing:'-.045em'}}>{session.title}</h1>
      </header>

      <section data-conversation-thread="episode-history" style={{marginTop:22,display:'flex',flexDirection:'column',gap:12}}>
        {messages.length===0?<div style={{color:S.muted,fontSize:12.5}}>Belum ada player-facing update di episode ini.</div>:messages.map(message=><ConversationBubble key={message.id} actor={message.actor} meta={moment(message.created_at)}>{message.body}</ConversationBubble>)}
      </section>

      {research.length>0&&<section style={{marginTop:32}}>
        <div style={{fontFamily:'"IBM Plex Mono", monospace',fontSize:8.5,letterSpacing:'.13em',color:S.amber}}>WORLD EVIDENCE</div>
        <h2 style={{margin:'7px 0 0',fontFamily:'"Space Grotesk", sans-serif',fontSize:21,letterSpacing:'-.02em'}}>Yang System cek di luar</h2>
        <div style={{display:'grid',gap:12,marginTop:13}}>{research.map(item=><details key={item.id} style={{border:`1px solid ${S.line}`,borderRadius:14,background:S.panel,padding:'12px 13px'}}>
          <summary style={{cursor:'pointer',fontSize:13,fontWeight:650}}>{item.topic}</summary>
          <div style={{marginTop:11,color:S.muted,fontSize:11.5,lineHeight:1.55}}>{item.research_question}</div>
          <div style={{marginTop:10,fontSize:12.5,lineHeight:1.62,whiteSpace:'pre-wrap'}}>{item.findings}</div>
          <div style={{marginTop:13,paddingTop:10,borderTop:`1px solid ${S.line}`,display:'grid',gap:8}}>{(Array.isArray(item.sources)?item.sources:[]).map((source,index)=><a key={`${item.id}-${index}`} href={source.url} target="_blank" rel="noreferrer" style={{color:S.gold,textDecoration:'none',fontSize:11.5,lineHeight:1.45}}>{source.title||source.url} ↗</a>)}</div>
        </details>)}</div>
      </section>}
    </>}
  </main></div>
}
