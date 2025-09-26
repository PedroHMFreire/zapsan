import { Request, Response } from 'express'
import { getPaginationConfig } from './adaptiveConfig'

export interface BatchRequest {
  id: string
  method: 'GET' | 'POST'
  endpoint: string
  params?: Record<string, any>
  body?: any
}

export interface BatchResponse {
  id: string
  status: number
  data?: any
  error?: string
  executionTime: number
}

export interface BatchResult {
  results: BatchResponse[]
  totalTime: number
  processed: number
  errors: number
}

// Mapa de handlers permitidos para batch
const BATCH_HANDLERS: Record<string, Function> = {}

// Registrar handler para um endpoint específico
export function registerBatchHandler(pattern: string, handler: Function) {
  BATCH_HANDLERS[pattern] = handler
}

// Handler principal do batch
export async function batchHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now()
  
  try {
    const requests = req.body?.requests as BatchRequest[]
    
    if (!Array.isArray(requests)) {
      res.status(400).json({ error: 'invalid_batch_format', message: 'Expected array of requests' })
      return
    }
    
    if (requests.length === 0) {
      res.status(400).json({ error: 'empty_batch', message: 'No requests provided' })
      return
    }
    
    // Limite de operações em batch baseado no contexto
    const config = getPaginationConfig(req)
    const maxBatchSize = req.deviceContext?.isMobile ? 5 : 10
    
    if (requests.length > maxBatchSize) {
      res.status(400).json({ 
        error: 'batch_too_large', 
        message: `Maximum ${maxBatchSize} operations allowed in batch`,
        limit: maxBatchSize
      })
      return
    }
    
    const results: BatchResponse[] = []
    let errorCount = 0
    
    // Processar cada operação
    for (const batchReq of requests) {
      const reqStart = Date.now()
      
      // Validar estrutura da requisição
      if (!batchReq.id || !batchReq.method || !batchReq.endpoint) {
        errorCount++
        results.push({
          id: batchReq.id || 'unknown',
          status: 400,
          error: 'invalid_request_structure',
          executionTime: Date.now() - reqStart
        })
        continue
      }
      
      try {
        const result = await processBatchRequest(batchReq, req)
        results.push({
          id: batchReq.id,
          status: result.status,
          data: result.data,
          executionTime: Date.now() - reqStart
        })
      } catch (error: any) {
        errorCount++
        results.push({
          id: batchReq.id,
          status: 500,
          error: error.message || 'internal_error',
          executionTime: Date.now() - reqStart
        })
      }
    }
    
    const totalTime = Date.now() - startTime
    
    const batchResult: BatchResult = {
      results,
      totalTime,
      processed: requests.length,
      errors: errorCount
    }
    
    // Status baseado nos resultados
    const hasErrors = errorCount > 0
    const allFailed = errorCount === requests.length
    
    if (allFailed) {
      res.status(500).json(batchResult)
    } else if (hasErrors) {
      res.status(207).json(batchResult) // Multi-status
    } else {
      res.status(200).json(batchResult)
    }
    
  } catch (error: any) {
    res.status(500).json({
      error: 'batch_processing_failed',
      message: error.message,
      totalTime: Date.now() - startTime
    })
  }
}

// Processar uma requisição individual do batch
async function processBatchRequest(batchReq: BatchRequest, originalReq: Request): Promise<{ status: number; data: any }> {
  const { endpoint, method, params, body } = batchReq
  
  // Normalizar endpoint
  const normalizedEndpoint = endpoint.replace(/^\//, '')
  
  // Buscar handler apropriado
  let handler: Function | undefined
  for (const pattern in BATCH_HANDLERS) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '[^/]+') + '$')
    if (regex.test(normalizedEndpoint)) {
      handler = BATCH_HANDLERS[pattern]
      break
    }
  }
  
  if (!handler) {
    throw new Error(`Endpoint not supported in batch: ${endpoint}`)
  }
  
  // Executar handler com contexto simulado
  const mockReq = {
    ...originalReq,
    params: params || {},
    body: body || {},
    query: params || {},
    method
  }
  
  let statusCode = 200
  let responseData: any = null
  
  const mockRes = {
    json: function(data: any) { responseData = data; return this },
    status: function(code: number) { statusCode = code; return this }
  }
  
  await handler(mockReq, mockRes)
  
  return {
    status: statusCode,
    data: responseData
  }
}

// Registrar handlers comuns
export function registerCommonBatchHandlers() {
  // Handler para status de sessões
  registerBatchHandler('sessions/*/status', async (req: any, res: any) => {
    const { getStatus } = await import('../wa')
    try {
      const status = getStatus(req.params.id || req.params['0'])
      res.json(status)
    } catch (error) {
      res.status(404).json({ error: 'session_not_found' })
    }
  })
  
  // Handler para mensagens
  registerBatchHandler('sessions/*/messages', async (req: any, res: any) => {
    const { getMessages } = await import('../wa')
    const { getPaginationConfig } = await import('./adaptiveConfig')
    
    try {
      const sessionId = req.params.id || req.params['0']
      const config = getPaginationConfig(req)
      const limit = Math.min(req.query.limit || config.messageLimit, config.maxLimit)
      
      const messages = getMessages(sessionId, limit)
      res.json({ messages, adaptive: { appliedLimit: limit } })
    } catch (error) {
      res.status(404).json({ error: 'session_not_found' })
    }
  })
  
  // Handler para contatos
  registerBatchHandler('me/contacts', async (req: any, res: any) => {
    const { supa } = await import('../db')
    const { getOrCreateUserSession } = await import('../userSessions')
    
    try {
      const uid = req.cookies?.uid
      if (!uid) {
        res.status(401).json({ error: 'unauthenticated' })
        return
      }
      
      const sessionId = await getOrCreateUserSession(uid)
      const { data } = await supa
        .from('contacts')
        .select('jid, name, is_group')
        .eq('session_key', sessionId)
        .order('name')
        .limit(50)
      
      res.json({ contacts: data || [] })
    } catch (error) {
      res.status(500).json({ error: 'fetch_failed' })
    }
  })
}