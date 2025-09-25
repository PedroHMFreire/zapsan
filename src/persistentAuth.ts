import { supa } from './db'
import fs from 'fs'
import path from 'path'

export interface AuthCredentials {
  sessionId: string
  creds: any
  keys: any
}

// Salvar credenciais no Supabase
export async function saveAuthToSupabase(sessionId: string, creds: any, keys: any) {
  try {
    const { error } = await supa
      .from('wa_sessions')
      .upsert({
        session_id: sessionId,
        creds: JSON.stringify(creds),
        keys: JSON.stringify(keys),
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'session_id'
      })
    
    if (error) {
      console.warn('[auth][save][supabase][error]', sessionId, error.message)
      return false
    }
    
    console.log('[auth][save][supabase][ok]', sessionId)
    return true
  } catch (err: any) {
    console.warn('[auth][save][supabase][catch]', sessionId, err.message)
    return false
  }
}

// Carregar credenciais do Supabase
export async function loadAuthFromSupabase(sessionId: string): Promise<{ creds: any, keys: any } | null> {
  try {
    const { data, error } = await supa
      .from('wa_sessions')
      .select('creds, keys')
      .eq('session_id', sessionId)
      .single()
    
    if (error || !data) {
      console.log('[auth][load][supabase][not_found]', sessionId)
      return null
    }
    
    const creds = JSON.parse(data.creds)
    const keys = JSON.parse(data.keys)
    
    console.log('[auth][load][supabase][ok]', sessionId)
    return { creds, keys }
  } catch (err: any) {
    console.warn('[auth][load][supabase][catch]', sessionId, err.message)
    return null
  }
}

// Deletar credenciais do Supabase
export async function deleteAuthFromSupabase(sessionId: string) {
  try {
    const { error } = await supa
      .from('wa_sessions')
      .delete()
      .eq('session_id', sessionId)
    
    if (error) {
      console.warn('[auth][delete][supabase][error]', sessionId, error.message)
      return false
    }
    
    console.log('[auth][delete][supabase][ok]', sessionId)
    return true
  } catch (err: any) {
    console.warn('[auth][delete][supabase][catch]', sessionId, err.message)
    return false
  }
}

// Implementação de AuthState que usa Supabase como fallback
export function createPersistentAuthState(sessionId: string) {
  const localDir = path.join(process.cwd(), 'sessions', sessionId)
  
  return {
    state: {
      creds: null as any,
      keys: null as any
    },
    
    async loadState() {
      // Tentar carregar do local primeiro (mais rápido)
      try {
        if (fs.existsSync(path.join(localDir, 'creds.json'))) {
          const credsPath = path.join(localDir, 'creds.json')
          const keysPath = path.join(localDir, 'app-state-sync-key-*.json')
          
          this.state.creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'))
          
          // Carregar keys (podem ser múltiplos arquivos)
          const keyFiles = fs.readdirSync(localDir).filter(f => f.startsWith('app-state-sync-key-'))
          this.state.keys = {}
          
          for (const keyFile of keyFiles) {
            const keyData = JSON.parse(fs.readFileSync(path.join(localDir, keyFile), 'utf-8'))
            Object.assign(this.state.keys, keyData)
          }
          
          console.log('[auth][load][local][ok]', sessionId)
          return this.state
        }
      } catch (err) {
        console.warn('[auth][load][local][error]', sessionId, err)
      }
      
      // Se não existe local, tentar Supabase
      const supabaseAuth = await loadAuthFromSupabase(sessionId)
      if (supabaseAuth) {
        this.state.creds = supabaseAuth.creds
        this.state.keys = supabaseAuth.keys
        
        // Salvar localmente para próximas vezes
        this.saveToLocal()
        
        return this.state
      }
      
      // Retornar estado vazio para nova sessão
      return this.state
    },
    
    async saveState() {
      // Salvar localmente
      this.saveToLocal()
      
      // Backup no Supabase
      await saveAuthToSupabase(sessionId, this.state.creds, this.state.keys)
    },
    
    saveToLocal() {
      try {
        fs.mkdirSync(localDir, { recursive: true })
        
        if (this.state.creds) {
          fs.writeFileSync(
            path.join(localDir, 'creds.json'), 
            JSON.stringify(this.state.creds, null, 2)
          )
        }
        
        if (this.state.keys) {
          // Salvar keys como arquivos separados (padrão Baileys)
          Object.entries(this.state.keys).forEach(([keyId, keyData]) => {
            fs.writeFileSync(
              path.join(localDir, `app-state-sync-key-${keyId}.json`),
              JSON.stringify(keyData, null, 2)
            )
          })
        }
      } catch (err) {
        console.warn('[auth][save][local][error]', sessionId, err)
      }
    }
  }
}