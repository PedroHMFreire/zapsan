import { supa } from './db'
import fs from 'fs'
import path from 'path'

export interface AuthCredentials {
  sessionId: string
  creds: any
  keys: any
}

// Função para converter Buffers/Uint8Arrays para base64
function serializeAuthData(data: any): any {
  if (Buffer.isBuffer(data)) {
    return {
      __type: 'Buffer',
      data: data.toString('base64')
    }
  }
  if (data instanceof Uint8Array) {
    return {
      __type: 'Uint8Array',
      data: Buffer.from(data).toString('base64')
    }
  }
  if (Array.isArray(data)) {
    return data.map(item => serializeAuthData(item))
  }
  if (data && typeof data === 'object') {
    const result: any = {}
    for (const [key, value] of Object.entries(data)) {
      result[key] = serializeAuthData(value)
    }
    return result
  }
  return data
}

// Função para converter dados serializados de volta para Buffers/Uint8Arrays
function deserializeAuthData(data: any): any {
  if (Array.isArray(data)) {
    return data.map(deserializeAuthData)
  }
  
  if (data && typeof data === 'object') {
    // Verificar se é um objeto marcado como Buffer/Uint8Array
    if (data.__type === 'Buffer' && typeof data.data === 'string') {
      try {
        return Buffer.from(data.data, 'base64')
      } catch (err) {
        console.warn('[auth][deserialize] Invalid base64 Buffer:', err)
        return data
      }
    }
    
    if (data.__type === 'Uint8Array' && typeof data.data === 'string') {
      try {
        return new Uint8Array(Buffer.from(data.data, 'base64'))
      } catch (err) {
        console.warn('[auth][deserialize] Invalid base64 Uint8Array:', err)
        return data
      }
    }
    
    // Processar recursivamente outros objetos
    const result: any = {}
    for (const [key, value] of Object.entries(data)) {
      result[key] = deserializeAuthData(value)
    }
    return result
  }
  
  return data
}

// Salvar credenciais no Supabase
export async function saveAuthToSupabase(sessionId: string, creds: any, keys: any) {
  try {
    // Serializar dados convertendo Buffers para formato JSON seguro
    const serializedCreds = serializeAuthData(creds)
    const serializedKeys = serializeAuthData(keys)
    
    const { error } = await supa
      .from('wa_sessions')
      .upsert({
        session_id: sessionId,
        creds: JSON.stringify(serializedCreds),
        keys: JSON.stringify(serializedKeys),
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
    
    // Deserializar dados convertendo Objects de volta para Buffers
    const rawCreds = JSON.parse(data.creds)
    const rawKeys = JSON.parse(data.keys)
    
    const creds = deserializeAuthData(rawCreds)
    const keys = deserializeAuthData(rawKeys)
    
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
          
          // Carregar e deserializar credenciais
          const rawCreds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'))
          this.state.creds = deserializeAuthData(rawCreds)
          
          // Carregar keys - formato compatível com Baileys
          this.state.keys = {}
          
          // Carregar TODOS os arquivos de key (não só app-state-sync)
          if (fs.existsSync(localDir)) {
            const allFiles = fs.readdirSync(localDir)
            
            // Arquivos de key do Baileys: app-state-sync-key-*, session-*, sender-key-*, pre-key-*
            const keyFiles = allFiles.filter(f => 
              f.startsWith('app-state-sync-key-') ||
              f.startsWith('session-') ||
              f.startsWith('sender-key-') ||
              f.startsWith('pre-key-') ||
              f.startsWith('sender-keys-') ||
              f.startsWith('sessions-')
            )
            
            for (const keyFile of keyFiles) {
              try {
                const keyPath = path.join(localDir, keyFile)
                const rawKeyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'))
                const deserializedKey = deserializeAuthData(rawKeyData)
                
                // Para app-state-sync-key, usar o ID como chave
                if (keyFile.startsWith('app-state-sync-key-')) {
                  const keyId = keyFile.replace('app-state-sync-key-', '').replace('.json', '')
                  this.state.keys[keyId] = deserializedKey
                } else {
                  // Para outros tipos, usar o nome do arquivo sem extensão como chave
                  const keyName = keyFile.replace('.json', '')
                  this.state.keys[keyName] = deserializedKey
                }
              } catch (err) {
                console.warn('[auth][load][key][error]', keyFile, err)
              }
            }
            
            console.log('[auth][load][local][keys]', sessionId, Object.keys(this.state.keys).length, 'keys loaded')
          }
          console.log('[auth][load][local][ok]', sessionId)
          return this.state
        } else {
          console.log('[auth][load][local][not_found]', sessionId, 'creds.json não existe')
        }
      } catch (err) {
        console.warn('[auth][load][local][error]', sessionId, err)
      }
      
      // Se não existe local, tentar Supabase
      console.log('[auth][load][supabase][trying]', sessionId)
      const supabaseAuth = await loadAuthFromSupabase(sessionId)
      if (supabaseAuth) {
        this.state.creds = supabaseAuth.creds
        this.state.keys = supabaseAuth.keys || {}
        
        console.log('[auth][load][supabase][ok]', sessionId, 'credenciais recuperadas do Supabase')
        
        // Salvar localmente para próximas vezes
        this.saveToLocal()
        
        return this.state
      } else {
        console.log('[auth][load][supabase][not_found]', sessionId)
      }
      
      // Retornar estado vazio para nova sessão
      console.log('[auth][load][empty]', sessionId, 'criando nova sessão')
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
          // Serializar credenciais antes de salvar
          const serializedCreds = serializeAuthData(this.state.creds)
          fs.writeFileSync(
            path.join(localDir, 'creds.json'), 
            JSON.stringify(serializedCreds, null, 2)
          )
        }
        
        if (this.state.keys) {
          // Salvar keys como arquivos separados (padrão Baileys)
          Object.entries(this.state.keys).forEach(([keyName, keyData]) => {
            const serializedKeyData = serializeAuthData(keyData)
            
            // Determinar o nome do arquivo baseado no tipo de key
            let fileName: string
            
            if (keyName.includes('app-state-sync-key') || (!keyName.includes('-') && !keyName.includes(':'))) {
              // App state sync keys (formato: keyId ou app-state-sync-key-keyId)
              const keyId = keyName.replace('app-state-sync-key-', '')
              fileName = `app-state-sync-key-${keyId}.json`
            } else {
              // Outros tipos de key (session, sender-key, pre-key)
              fileName = `${keyName}.json`
            }
            
            fs.writeFileSync(
              path.join(localDir, fileName),
              JSON.stringify(serializedKeyData, null, 2)
            )
          })
        }
      } catch (err) {
        console.warn('[auth][save][local][error]', sessionId, err)
      }
    }
  }
}