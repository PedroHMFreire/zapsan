/**
 * Módulo de segurança com funções de sanitização e validação
 */

// Sanitizar HTML removendo tags perigosas
export function sanitizeHtml(input: string): string {
  if (typeof input !== 'string') return ''
  
  return input
    .replace(/[<>]/g, '') // Remove < e >
    .replace(/javascript:/gi, '') // Remove javascript:
    .replace(/on\w+\s*=/gi, '') // Remove event handlers
    .trim()
}

// Sanitizar para SQL (previne injection)
export function sanitizeSql(input: string): string {
  if (typeof input !== 'string') return ''
  
  return input
    .replace(/['"\\;]/g, '') // Remove aspas e pontos-vírgula
    .replace(/--/g, '') // Remove comentários SQL
    .replace(/\/\*/g, '') // Remove comentários block
    .trim()
}

// Validar session ID (deve ser alfanumérico + hífen + underscore)
export function validateSessionId(sessionId: string): boolean {
  if (typeof sessionId !== 'string') return false
  if (sessionId.length < 3 || sessionId.length > 100) return false
  return /^[a-zA-Z0-9_-]+$/.test(sessionId)
}

// Validar email
export function validateEmail(email: string): boolean {
  if (typeof email !== 'string') return false
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email) && email.length <= 254
}

// Sanitizar entrada genérica baseada no tipo
export function sanitizeInput(input: string, type: string = 'text', maxLength: number = 1000): string {
  if (typeof input !== 'string') return ''
  
  let sanitized = input.trim().substring(0, maxLength)
  
  switch (type) {
    case 'email':
      return sanitized.toLowerCase().replace(/[^\w@.-]/g, '')
    case 'name':
      return sanitizeUsername(sanitized)
    case 'whatsapp_jid':
      return sanitized.replace(/[^0-9@.-]/g, '')
    case 'text':
    default:
      return sanitizeHtml(sanitized)
  }
}

// Sanitizar nome de usuário
export function sanitizeUsername(name: string): string {
  if (typeof name !== 'string') return ''
  return name
    .replace(/[<>'"&]/g, '') // Remove caracteres perigosos
    .replace(/\s+/g, ' ') // Normaliza espaços
    .trim()
    .substring(0, 100) // Limita tamanho
}

// Validar JID do WhatsApp
export function validateWhatsAppJid(jid: string): boolean {
  if (typeof jid !== 'string') return false
  if (jid.length > 100) return false
  
  // Formatos válidos: numero@s.whatsapp.net ou numero@g.us
  const jidRegex = /^[0-9]+@(s\.whatsapp\.net|g\.us)$/
  return jidRegex.test(jid)
}

// Rate limiting por IP
const ipAttempts = new Map<string, { count: number; lastAttempt: number }>()
const MAX_ATTEMPTS_PER_IP = 100 // por hora
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000 // 1 hora

export function checkRateLimit(ip: string): { allowed: boolean; remainingAttempts: number } {
  const now = Date.now()
  const clientData = ipAttempts.get(ip)
  
  if (!clientData) {
    ipAttempts.set(ip, { count: 1, lastAttempt: now })
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS_PER_IP - 1 }
  }
  
  // Reset se passou da janela de tempo
  if (now - clientData.lastAttempt > ATTEMPT_WINDOW_MS) {
    ipAttempts.set(ip, { count: 1, lastAttempt: now })
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS_PER_IP - 1 }
  }
  
  // Incrementar tentativas
  clientData.count++
  clientData.lastAttempt = now
  
  const remainingAttempts = Math.max(0, MAX_ATTEMPTS_PER_IP - clientData.count)
  const allowed = clientData.count <= MAX_ATTEMPTS_PER_IP
  
  return { allowed, remainingAttempts }
}

// Limpar dados antigos do rate limiting (executar periodicamente)
export function cleanupRateLimit() {
  const now = Date.now()
  for (const [ip, data] of ipAttempts.entries()) {
    if (now - data.lastAttempt > ATTEMPT_WINDOW_MS) {
      ipAttempts.delete(ip)
    }
  }
}

// Executar limpeza a cada hora
setInterval(cleanupRateLimit, ATTEMPT_WINDOW_MS)

// Validar parâmetros de paginação
export function validatePagination(limit?: any, offset?: any): { limit: number; offset: number } {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 500)
  const safeOffset = Math.max(parseInt(offset) || 0, 0)
  return { limit: safeLimit, offset: safeOffset }
}

// Escapar conteúdo para logs (previne log injection)
export function sanitizeForLog(input: any): string {
  if (typeof input !== 'string') {
    input = JSON.stringify(input)
  }
  
  return input
    .replace(/[\r\n]/g, ' ') // Remove quebras de linha
    .replace(/[^\x20-\x7E]/g, '?') // Remove caracteres não-ASCII
    .substring(0, 500) // Limita tamanho
}