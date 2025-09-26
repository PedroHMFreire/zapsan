/**
 * Utilitários de segurança para o frontend
 */

// Sanitização de HTML para prevenir XSS
export function sanitizeHtml(html) {
  // Criar elemento temporário para escape
  const temp = document.createElement('div');
  temp.textContent = html;
  return temp.innerHTML;
}

// Escapar caracteres especiais
export function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };
  
  return text.replace(/[&<>"'/]/g, (s) => map[s]);
}

// Validação de entrada
export function validateInput(input, type = 'text', maxLength = 1000) {
  if (typeof input !== 'string') return false;
  if (input.length > maxLength) return false;
  
  switch (type) {
    case 'phone':
      // Aceitar apenas dígitos e alguns caracteres especiais
      return /^[0-9+\-\s()]{8,15}$/.test(input);
    case 'message':
      // Evitar scripts e tags HTML
      return !/[<>]/g.test(input);
    case 'sessionId':
      // Formato de UUID ou string alfanumérica
      return /^[a-zA-Z0-9_-]{8,100}$/.test(input);
    default:
      return true;
  }
}

// Rate limiting no frontend
class ClientRateLimit {
  constructor(maxAttempts = 20, windowMs = 60000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }
  
  canMakeRequest(key = 'default') {
    const now = Date.now();
    const record = this.attempts.get(key);
    
    if (!record) {
      this.attempts.set(key, { count: 1, firstAttempt: now });
      return true;
    }
    
    // Reset se passou da janela
    if (now - record.firstAttempt > this.windowMs) {
      this.attempts.set(key, { count: 1, firstAttempt: now });
      return true;
    }
    
    record.count++;
    
    if (record.count > this.maxAttempts) {
      return false;
    }
    
    return true;
  }
  
  getRemainingTime(key = 'default') {
    const record = this.attempts.get(key);
    if (!record) return 0;
    
    const elapsed = Date.now() - record.firstAttempt;
    return Math.max(0, this.windowMs - elapsed);
  }
}

// Instância global de rate limiting
export const rateLimiter = new ClientRateLimit(20, 60000); // 20 tentativas por minuto

// Função segura para inserir conteúdo no DOM
export function safeSetInnerHTML(element, content) {
  if (!element || typeof content !== 'string') return;
  element.textContent = content; // Usar textContent ao invés de innerHTML
}

// Função segura para inserir HTML (quando necessário)
export function safeSetHTML(element, html) {
  if (!element || typeof html !== 'string') return;
  
  // Sanitizar antes de inserir
  const sanitized = sanitizeHtml(html);
  element.innerHTML = sanitized;
}

// Validação de URL para evitar redirecionamentos maliciosos
export function validateUrl(url) {
  if (typeof url !== 'string') return false;
  
  try {
    const parsed = new URL(url, window.location.origin);
    // Aceitar apenas URLs do mesmo domínio
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

// Função para log seguro (evitar vazamento de dados sensíveis)
export function safeLog(message, data = {}) {
  if (typeof message !== 'string') return;
  
  // Sanitizar dados sensíveis
  const sanitizedData = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.toLowerCase().includes('password') || 
        key.toLowerCase().includes('token') || 
        key.toLowerCase().includes('secret')) {
      sanitizedData[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      sanitizedData[key] = value.substring(0, 100); // Limitar tamanho
    } else {
      sanitizedData[key] = value;
    }
  }
  
  console.log(`[ZapSan] ${message}`, sanitizedData);
}