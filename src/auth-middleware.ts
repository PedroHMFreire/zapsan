/**
 * Middleware de autenticação e autorização
 */

import { Request, Response, NextFunction } from 'express'
import { sanitizeForLog } from './security'

// Estender Request para incluir userId
declare global {
  namespace Express {
    interface Request {
      userId?: string
    }
  }
}

// Middleware para verificar autenticação
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const uid = req.cookies?.uid
  
  if (!uid) {
    console.warn(`[auth] Tentativa de acesso sem autenticação: ${sanitizeForLog(req.path)} - IP: ${req.ip}`)
    return res.status(401).json({ error: 'unauthenticated', message: 'Login necessário' })
  }
  
  // Validar formato do UID (deve ser UUID ou string alfanumérica)
  if (typeof uid !== 'string' || uid.length < 8 || uid.length > 100) {
    console.warn(`[auth] UID inválido detectado: ${sanitizeForLog(uid)} - IP: ${req.ip}`)
    res.clearCookie('uid')
    return res.status(401).json({ error: 'invalid_session', message: 'Sessão inválida' })
  }
  
  // Adicionar userId ao request
  req.userId = uid
  next()
}

// Middleware para verificar propriedade de sessão
export function requireSessionOwnership(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.params.sessionId || req.params.id
  const userId = req.userId
  
  if (!sessionId || !userId) {
    return res.status(400).json({ error: 'bad_request', message: 'session_id ou user_id ausente' })
  }
  
  // Verificar se o usuário tem acesso a esta sessão
  // Implementar lógica de verificação baseada no banco de dados
  // Por enquanto, permitir acesso (pode ser refinado posteriormente)
  next()
}

// Middleware para logs de segurança
export function securityLogger(req: Request, res: Response, next: NextFunction) {
  // Log de tentativas suspeitas
  const suspiciousPatterns = [
    /[<>]/,                    // XSS básico
    /javascript:/i,            // JavaScript injection
    /union\s+select/i,         // SQL injection
    /\.\.\//,                  // Path traversal
    /%2e%2e%2f/i,             // Path traversal encoded
    /eval\(/i,                 // Code injection
    /exec\(/i,                 // Command injection
  ]
  
  const url = req.url
  const body = JSON.stringify(req.body || {})
  const isSuspicious = suspiciousPatterns.some(pattern => 
    pattern.test(url) || pattern.test(body)
  )
  
  if (isSuspicious) {
    console.warn(`[security] Tentativa suspeita detectada:`, {
      ip: req.ip,
      userAgent: sanitizeForLog(req.get('User-Agent') || ''),
      url: sanitizeForLog(url),
      method: req.method,
      body: sanitizeForLog(body),
      timestamp: new Date().toISOString()
    })
  }
  
  next()
}

// Rate limiting específico por usuário autenticado
const userAttempts = new Map<string, { count: number; lastAttempt: number }>()
const USER_MAX_ATTEMPTS = 200 // por hora
const USER_WINDOW_MS = 60 * 60 * 1000 // 1 hora

export function userRateLimit(req: Request, res: Response, next: NextFunction) {
  const userId = req.userId
  if (!userId) {
    return next() // Se não autenticado, não aplicar rate limit por usuário
  }
  
  const now = Date.now()
  const userData = userAttempts.get(userId)
  
  if (!userData) {
    userAttempts.set(userId, { count: 1, lastAttempt: now })
    return next()
  }
  
  // Reset se passou da janela de tempo
  if (now - userData.lastAttempt > USER_WINDOW_MS) {
    userAttempts.set(userId, { count: 1, lastAttempt: now })
    return next()
  }
  
  // Incrementar tentativas
  userData.count++
  userData.lastAttempt = now
  
  if (userData.count > USER_MAX_ATTEMPTS) {
    console.warn(`[auth] Rate limit por usuário excedido: ${sanitizeForLog(userId)}`)
    return res.status(429).json({ 
      error: 'user_rate_limited', 
      message: 'Muitas operações. Aguarde 1 hora.' 
    })
  }
  
  next()
}

// Limpeza periódica
setInterval(() => {
  const now = Date.now()
  for (const [userId, data] of userAttempts.entries()) {
    if (now - data.lastAttempt > USER_WINDOW_MS) {
      userAttempts.delete(userId)
    }
  }
}, USER_WINDOW_MS)