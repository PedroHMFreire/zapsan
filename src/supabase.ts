import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Centraliza criação do client. Usa URL e chave anon para operações públicas.
// Para operações administrativas (ex: upsert direto em tabela), pode-se usar SERVICE_ROLE via outra instância.

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

let supabase: SupabaseClient | null = null
let supabaseAdmin: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if(!supabase){
    if(!SUPABASE_URL || !SUPABASE_ANON_KEY){
      throw new Error('supabase_env_missing')
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  }
  return supabase
}

export function getSupabaseAdmin(): SupabaseClient {
  if(!supabaseAdmin){
    if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY){
      throw new Error('supabase_admin_env_missing')
    }
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  }
  return supabaseAdmin
}

export function hasSupabaseEnv(){
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY)
}
