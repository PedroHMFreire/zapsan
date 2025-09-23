import { getSupabase, hasSupabaseEnv } from './supabase'
import { createUser as createLocalUser, findUser as findLocalUser, authenticate as authLocal } from './users'

// Tabela esperada no Supabase: profiles (ou users) com colunas: id (uuid ou text), email, name, plan
// Se o projeto já tem uma tabela específica (ex: users), ajuste TABLE_NAME abaixo.
const TABLE_NAME = process.env.SUPABASE_USERS_TABLE || 'users'

export interface SupaUserData {
  id: string
  email: string
  name?: string
  plan?: string | null
}

export interface AuthResult {
  ok: boolean
  userId?: string
  sessionId?: string
  error?: string
  created?: boolean
}

// Registra usuário: cria no auth do Supabase + registra linha na tabela (se não existir). Fallback local se env ausente.
export async function registerUser(name: string, email: string, password: string): Promise<AuthResult> {
  const emailLc = email.toLowerCase().trim()
  if(!hasSupabaseEnv()){
    // fallback local agora usa phone (reutilizando email como phone para compat temporal)
    try {
      const user = await createLocalUser({ phone: emailLc, name, password })
      return { ok:true, userId: user.id, created:true }
    } catch (err:any){
      if(err?.message === 'user_exists') return { ok:false, error:'user_exists' }
      return { ok:false, error:'internal_error' }
    }
  }
  const supabase = getSupabase()
  // 1. signUp (não envia email de confirmação se não configurado)
  const { data, error } = await supabase.auth.signUp({ email: emailLc, password, options: { data: { name } } })
  if(error){
    if(error.message.includes('User already registered')) return { ok:false, error:'user_exists' }
    return { ok:false, error:'supabase_signup_failed' }
  }
  const uid = data.user?.id || emailLc
  // 2. Upsert na tabela de perfis (se usar id diferente do email)
  try {
    await supabase.from(TABLE_NAME).upsert({ id: uid, email: emailLc, name, plan: 'free' }).select().single()
  } catch { /* ignore profile upsert failure */ }
  return { ok:true, userId: uid, created:true }
}

export async function loginUser(email: string, password: string): Promise<AuthResult> {
  const emailLc = email.toLowerCase().trim()
  if(!hasSupabaseEnv()){
    const u = await authLocal(emailLc, password)
    if(!u) return { ok:false, error:'invalid_credentials' }
    return { ok:true, userId: u.id }
  }
  const supabase = getSupabase()
  const { data, error } = await supabase.auth.signInWithPassword({ email: emailLc, password })
  if(error){
    if(error.message.toLowerCase().includes('invalid')) return { ok:false, error:'invalid_credentials' }
    return { ok:false, error:'supabase_login_failed' }
  }
  const uid = data.user?.id || emailLc
  return { ok:true, userId: uid }
}

export async function fetchUserProfile(userIdOrEmail: string): Promise<SupaUserData | null> {
  if(!hasSupabaseEnv()){
    const u = await findLocalUser(userIdOrEmail.toLowerCase())
    if(!u) return null
    return { id: u.id, email: u.phone, name: u.name || undefined, plan: 'local' }
  }
  const supabase = getSupabase()
  // Procurar por id OU email
  const { data, error } = await supabase.from(TABLE_NAME)
    .select('id,email,name,plan')
    .or(`id.eq.${userIdOrEmail},email.eq.${userIdOrEmail.toLowerCase()}`)
    .limit(1)
    .maybeSingle()
  if(error || !data) return null
  return data as SupaUserData
}
