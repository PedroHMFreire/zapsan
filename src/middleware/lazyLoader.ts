import { Request, Response } from 'express'
import { getPaginationConfig } from './adaptiveConfig'

export interface LazyLoadMeta {
  hasMore: boolean
  nextCursor?: string
  total?: number
  loaded: number
  remaining?: number
  adaptiveConfig: {
    currentLimit: number
    deviceType: string
    connectionType: string
  }
}

export interface LazyLoadResponse<T = any> {
  data: T[]
  meta: LazyLoadMeta
  loadTime: number
}

// Cache para metadados (evita recálculos)
const metaCache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 60000 // 1 minuto

export function lazyLoadWrapper<T>(
  dataFetcher: (limit: number, cursor?: string) => Promise<T[]>,
  totalCounter?: () => Promise<number>,
  cacheKey?: string
) {
  return async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now()
    
    try {
      const config = getPaginationConfig(req)
      const cursor = req.query.cursor as string
      const requestedLimit = parseInt(req.query.limit as string) || config.messageLimit
      const limit = Math.min(requestedLimit, config.maxLimit)
      
      // Verificar cache de metadados
      let cachedMeta = null
      if (cacheKey && !cursor) {
        const cached = metaCache.get(cacheKey)
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          cachedMeta = cached.data
        }
      }
      
      // Buscar dados principais
      const data = await dataFetcher(limit + 1, cursor) // +1 para detectar hasMore
      
      // Separar dados e detectar se há mais
      const hasMore = data.length > limit
      const actualData = hasMore ? data.slice(0, limit) : data
      
      // Calcular próximo cursor (usar o último item)
      let nextCursor: string | undefined
      if (hasMore && actualData.length > 0) {
        const lastItem = actualData[actualData.length - 1]
        // Assumir que itens têm 'id' ou 'timestamp' para cursor
        nextCursor = (lastItem as any).id || (lastItem as any).timestamp || String(actualData.length)
      }
      
      // Buscar total se necessário (e não estiver em cache)
      let total: number | undefined
      if (totalCounter && (!cursor || !cachedMeta)) {
        try {
          total = await totalCounter()
          
          // Cachear metadados se temos chave
          if (cacheKey) {
            metaCache.set(cacheKey, {
              data: { total, timestamp: Date.now() },
              timestamp: Date.now()
            })
          }
        } catch (error) {
          // Total é opcional, continuar sem ele
          console.warn('Failed to get total count:', error)
        }
      } else if (cachedMeta) {
        total = cachedMeta.total
      }
      
      // Montar metadados
      const meta: LazyLoadMeta = {
        hasMore,
        nextCursor,
        total,
        loaded: actualData.length,
        remaining: total ? Math.max(0, total - (actualData.length + (cursor ? 1 : 0))) : undefined,
        adaptiveConfig: {
          currentLimit: limit,
          deviceType: req.deviceContext?.isMobile ? 'mobile' : 'desktop',
          connectionType: req.deviceContext?.connectionType || 'unknown'
        }
      }
      
      const response: LazyLoadResponse<T> = {
        data: actualData,
        meta,
        loadTime: Date.now() - startTime
      }
      
      res.json(response)
      
    } catch (error: any) {
      res.status(500).json({
        error: 'lazy_load_failed',
        message: error.message,
        loadTime: Date.now() - startTime
      })
    }
  }
}

// Wrapper especializado para mensagens
export function lazyLoadMessages(sessionId: string = 'default') {
  return lazyLoadWrapper<any>(
    async (limit: number, cursor?: string) => {
      const { getMessages } = await import('../wa')
      const allMessages = getMessages(sessionId, limit * 2) // Pegar mais para implementar cursor
      
      // Implementar cursor simples baseado em índice
      if (cursor) {
        const startIndex = parseInt(cursor) || 0
        return allMessages.slice(startIndex, startIndex + limit)
      }
      
      return allMessages.slice(0, limit)
    },
    async () => {
      const { getMessages } = await import('../wa')
      const allMessages = getMessages(sessionId, 10000) // Limite alto para contar
      return allMessages.length
    },
    `messages-${sessionId}`
  )
}

// Wrapper especializado para contatos
export function lazyLoadContacts() {
  return lazyLoadWrapper<any>(
    async (limit: number, cursor?: string) => {
      const { supa } = await import('../db')
      
      let query = supa
        .from('contacts')
        .select('jid, name, is_group, last_seen')
        .order('name')
        .limit(limit)
      
      if (cursor) {
        query = query.gt('name', cursor)
      }
      
      const { data, error } = await query
      if (error) throw error
      
      return data || []
    },
    async () => {
      const { supa } = await import('../db')
      const { count } = await supa
        .from('contacts')
        .select('*', { count: 'exact', head: true })
      
      return count || 0
    },
    'contacts'
  )
}

// Wrapper especializado para sessões
export function lazyLoadSessions() {
  return lazyLoadWrapper<any>(
    async (limit: number, cursor?: string) => {
      const { supa } = await import('../db')
      
      let query = supa
        .from('user_sessions')
        .select('session_key, created_at, last_activity, status')
        .order('last_activity', { ascending: false })
        .limit(limit)
      
      if (cursor) {
        query = query.lt('last_activity', cursor)
      }
      
      const { data, error } = await query
      if (error) throw error
      
      return data || []
    },
    async () => {
      const { supa } = await import('../db')
      const { count } = await supa
        .from('user_sessions')
        .select('*', { count: 'exact', head: true })
      
      return count || 0
    },
    'sessions'
  )
}

// Limpar cache periodicamente
export function startMetaCacheCleaner() {
  setInterval(() => {
    const now = Date.now()
    for (const [key, value] of metaCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        metaCache.delete(key)
      }
    }
  }, CACHE_TTL)
}