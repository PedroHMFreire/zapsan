import crypto from 'crypto'
import { supa } from './db'
// import { createOrLoadSession } from './wa'

// Retorna a sessionId mais recente ou cria uma nova vinculada ao userId
export async function getOrCreateUserSession(userId: string): Promise<string> {
  if(!userId) throw new Error('missing_user')
  const { data: existingList } = await supa.from('sessions')
    .select('session_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
  if(existingList && existingList.length){
    return (existingList[0] as any).session_id
  }
  const sessionId = 'u_' + crypto.randomUUID()
  await supa.from('sessions').insert({ session_id: sessionId, status: 'connecting', user_id: userId })
  return sessionId
}

export async function getUserSession(userId: string): Promise<string | null> {
  if(!userId) return null
  const { data } = await supa.from('sessions')
    .select('session_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
  if(data && data.length){
    return (data[0] as any).session_id
  }
  return null
}

export async function setUserSession(userId: string, sessionId: string): Promise<void> {
  if(!userId || !sessionId) throw new Error('missing_params')
  // Upsert manual: tenta atualizar, se não existir insere
  const { error: updErr } = await supa.from('sessions').update({ user_id: userId }).eq('session_id', sessionId)
  if(updErr){ /* continua tentativa de insert */ }
  // Checar se atualizou alguma (Supabase não retorna contagem sem retornar=representation) -> simplificamos com insert ignorando conflito
  await supa.from('sessions').upsert({ session_id: sessionId, status: 'connecting', user_id: userId }, { onConflict: 'session_id' })
}

export async function ensureSessionStarted(userId: string): Promise<{ sessionId: string }> {
  const sessionId = await getOrCreateUserSession(userId)
  // Não iniciar automaticamente para evitar gerar QR sem ação manual
  return { sessionId }
}

// (Opcional) manter função de listagem antiga para debug, agora vinda do banco
export async function listUserSessions(){
  const { data } = await supa.from('sessions').select('session_id, user_id, created_at').order('created_at', { ascending: false })
  const map: Record<string,string> = {}
  ;(data||[]).forEach((s: any) => { if(s.user_id && !(s.user_id in map)) map[s.user_id] = s.session_id })
  return map
}
