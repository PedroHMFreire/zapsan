/**
 * Sistema de Batching e Debounce para otimização de API calls
 * Especialmente otimizado para mobile com conexões lentas
 */

class APIBatchManager {
  constructor(options = {}) {
    this.options = {
      batchDelay: 300,        // ms para aguardar mais requests
      maxBatchSize: 10,       // máximo requests por batch
      maxRetries: 3,          // tentativas em erro
      timeout: 10000,         // timeout por request
      priority: true,         // usar requestIdleCallback
      ...options
    }
    
    this.batches = new Map()
    this.debouncers = new Map()
    this.requestQueue = []
    this.processing = false
    
    this.init()
  }

  init() {
    this.setupConnectionMonitoring()
    this.setupPerformanceOptimization()
  }

  setupConnectionMonitoring() {
    if ('connection' in navigator) {
      this.connectionInfo = navigator.connection
      
      navigator.connection.addEventListener('change', () => {
        this.adaptToConnection()
      })
      
      this.adaptToConnection()
    }
  }

  adaptToConnection() {
    if (!this.connectionInfo) return

    const { effectiveType, downlink, rtt } = this.connectionInfo
    
    // Ajustar configurações baseado na conexão
    if (effectiveType === 'slow-2g' || effectiveType === '2g') {
      this.options.batchDelay = 1000      // Mais tempo para batch
      this.options.maxBatchSize = 5       // Batches menores
      this.options.timeout = 20000        // Timeout maior
    } else if (effectiveType === '3g') {
      this.options.batchDelay = 500
      this.options.maxBatchSize = 8
      this.options.timeout = 15000
    } else { // 4g ou melhor
      this.options.batchDelay = 200
      this.options.maxBatchSize = 15
      this.options.timeout = 8000
    }

    console.log(`📶 Conexão adaptada: ${effectiveType} (${downlink}Mbps, ${rtt}ms RTT)`)
  }

  setupPerformanceOptimization() {
    // Usar requestIdleCallback para não bloquear UI
    this.scheduleWork = ('requestIdleCallback' in window) 
      ? (callback) => requestIdleCallback(callback, { timeout: 1000 })
      : (callback) => setTimeout(callback, 0)
  }

  // Método principal para fazer requests
  request(url, options = {}) {
    return new Promise((resolve, reject) => {
      const requestId = this.generateRequestId()
      const batchKey = this.getBatchKey(url, options.method || 'GET')
      
      const requestData = {
        id: requestId,
        url,
        options,
        resolve,
        reject,
        timestamp: Date.now(),
        retries: 0
      }

      // Adicionar ao batch apropriado
      if (!this.batches.has(batchKey)) {
        this.batches.set(batchKey, [])
      }
      
      this.batches.get(batchKey).push(requestData)
      
      // Debounce o processamento do batch
      this.debounceBatch(batchKey)
    })
  }

  // Debounce para agrupar requests
  debounceBatch(batchKey) {
    if (this.debouncers.has(batchKey)) {
      clearTimeout(this.debouncers.get(batchKey))
    }

    const timeoutId = setTimeout(() => {
      this.processBatch(batchKey)
      this.debouncers.delete(batchKey)
    }, this.options.batchDelay)

    this.debouncers.set(batchKey, timeoutId)
  }

  async processBatch(batchKey) {
    const requests = this.batches.get(batchKey)
    if (!requests || requests.length === 0) return

    this.batches.delete(batchKey)

    // Dividir em chunks se necessário
    const chunks = this.chunkArray(requests, this.options.maxBatchSize)
    
    for (const chunk of chunks) {
      await this.executeChunk(chunk)
    }
  }

  async executeChunk(requests) {
    // Usar requestIdleCallback para não bloquear
    return new Promise((resolve) => {
      this.scheduleWork(async () => {
        const promises = requests.map(req => this.executeRequest(req))
        await Promise.allSettled(promises)
        resolve()
      })
    })
  }

  async executeRequest(requestData) {
    const { id, url, options, resolve, reject } = requestData
    
    try {
      // Adicionar timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.options.timeout)
      
      const finalOptions = {
        ...options,
        signal: controller.signal
      }

      console.log(`🚀 Executando request: ${id}`)
      
      const response = await fetch(url, finalOptions)
      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      resolve(data)
      
      console.log(`✅ Request completo: ${id}`)
      
    } catch (error) {
      console.warn(`❌ Erro no request ${id}:`, error.message)
      
      // Retry logic
      if (requestData.retries < this.options.maxRetries && !error.name === 'AbortError') {
        requestData.retries++
        console.log(`🔄 Tentativa ${requestData.retries} para ${id}`)
        
        // Exponential backoff
        const delay = Math.pow(2, requestData.retries) * 1000
        setTimeout(() => this.executeRequest(requestData), delay)
      } else {
        reject(error)
      }
    }
  }

  // Debounce genérico para outras operações
  debounce(key, callback, delay = 300) {
    if (this.debouncers.has(key)) {
      clearTimeout(this.debouncers.get(key))
    }

    const timeoutId = setTimeout(() => {
      callback()
      this.debouncers.delete(key)
    }, delay)

    this.debouncers.set(key, timeoutId)
  }

  // Throttle para limitar frequência
  throttle(key, callback, limit = 1000) {
    const now = Date.now()
    const lastCall = this.throttleMap?.get(key) || 0
    
    if (!this.throttleMap) this.throttleMap = new Map()
    
    if (now - lastCall >= limit) {
      this.throttleMap.set(key, now)
      callback()
    }
  }

  // Utility methods
  getBatchKey(url, method) {
    // Agrupar requests similares
    const baseUrl = url.split('?')[0]
    return `${method}:${baseUrl}`
  }

  generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  chunkArray(array, size) {
    const chunks = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }

  // Performance monitoring
  getStats() {
    return {
      activeBatches: this.batches.size,
      pendingDebouncers: this.debouncers.size,
      queueSize: this.requestQueue.length,
      connectionType: this.connectionInfo?.effectiveType || 'unknown'
    }
  }

  // Cleanup
  destroy() {
    // Limpar timeouts
    this.debouncers.forEach(timeoutId => clearTimeout(timeoutId))
    this.debouncers.clear()
    
    if (this.throttleMap) {
      this.throttleMap.clear()
    }
    
    this.batches.clear()
  }
}

// Helper functions para casos de uso comuns
class SmartAPIHelper {
  constructor(batchManager) {
    this.batcher = batchManager || new APIBatchManager()
    this.cache = new Map()
    this.cacheExpiry = new Map()
  }

  // GET com cache inteligente
  async get(url, options = {}) {
    const cacheKey = `GET:${url}`
    const cached = this.getFromCache(cacheKey)
    
    if (cached) {
      console.log(`💾 Cache hit: ${url}`)
      return cached
    }

    const data = await this.batcher.request(url, { method: 'GET', ...options })
    
    // Cache por 5 minutos por padrão
    this.setCache(cacheKey, data, options.cacheTime || 300000)
    
    return data
  }

  // POST sem cache
  async post(url, body, options = {}) {
    return this.batcher.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
      ...options
    })
  }

  // Busca com debounce automático
  search(query, url, options = {}) {
    const searchKey = `search:${url}`
    
    return new Promise((resolve) => {
      this.batcher.debounce(searchKey, async () => {
        try {
          const results = await this.get(`${url}?q=${encodeURIComponent(query)}`, options)
          resolve(results)
        } catch (error) {
          resolve([])
        }
      }, 500) // 500ms debounce para buscas
    })
  }

  // Cache methods
  getFromCache(key) {
    const expiry = this.cacheExpiry.get(key)
    if (expiry && Date.now() > expiry) {
      this.cache.delete(key)
      this.cacheExpiry.delete(key)
      return null
    }
    return this.cache.get(key)
  }

  setCache(key, data, ttl) {
    this.cache.set(key, data)
    if (ttl > 0) {
      this.cacheExpiry.set(key, Date.now() + ttl)
    }
  }

  clearCache() {
    this.cache.clear()
    this.cacheExpiry.clear()
  }
}

// CSS para feedback visual de loading
const batchingCSS = `
  .api-loading {
    pointer-events: none;
    opacity: 0.6;
    position: relative;
  }
  
  .api-loading::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 20px;
    height: 20px;
    margin: -10px 0 0 -10px;
    border: 2px solid #25D366;
    border-right: 2px solid transparent;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    z-index: 1000;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
`

// Adicionar CSS
const style = document.createElement('style')
style.textContent = batchingCSS
document.head.appendChild(style)

// Instância global
const globalBatcher = new APIBatchManager()
const smartAPI = new SmartAPIHelper(globalBatcher)

// Export
window.APIBatchManager = APIBatchManager
window.SmartAPIHelper = SmartAPIHelper
window.apiBatcher = globalBatcher
window.api = smartAPI

// Helper para facilitar uso
window.debounce = (func, delay = 300) => {
  let timeoutId
  return function (...args) {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => func.apply(this, args), delay)
  }
}

window.throttle = (func, limit = 1000) => {
  let inThrottle
  return function (...args) {
    if (!inThrottle) {
      func.apply(this, args)
      inThrottle = true
      setTimeout(() => inThrottle = false, limit)
    }
  }
}