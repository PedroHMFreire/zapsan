/**
 * Lazy Loading System para imagens e media
 * Otimizado para performance mobile
 */

class LazyMediaLoader {
  constructor(options = {}) {
    this.options = {
      rootMargin: '50px', // Carregar quando 50px antes de entrar na view
      threshold: 0.1,     // 10% visível para trigger
      maxConcurrent: 3,   // Máximo 3 downloads simultâneos
      retryAttempts: 3,   // Tentativas em caso de erro
      ...options
    }
    
    this.loadingQueue = new Set()
    this.loadingCount = 0
    this.cache = new Map() // Cache de URLs processadas
    
    this.init()
  }

  init() {
    this.setupIntersectionObserver()
    this.setupPreloader()
  }

  setupIntersectionObserver() {
    if ('IntersectionObserver' in window) {
      this.observer = new IntersectionObserver(
        (entries) => this.handleIntersection(entries),
        {
          rootMargin: this.options.rootMargin,
          threshold: this.options.threshold
        }
      )
    }
  }

  setupPreloader() {
    // Pool de Image objects para preload
    this.imagePool = []
    for (let i = 0; i < this.options.maxConcurrent; i++) {
      this.imagePool.push(new Image())
    }
  }

  // Observar elementos lazy
  observe(element) {
    if (this.observer && element) {
      this.observer.observe(element)
    }
  }

  unobserve(element) {
    if (this.observer && element) {
      this.observer.unobserve(element)
    }
  }

  handleIntersection(entries) {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        this.loadMedia(entry.target)
        this.unobserve(entry.target)
      }
    })
  }

  async loadMedia(element) {
    const src = element.dataset.src
    if (!src || this.loadingQueue.has(element)) return

    // Verificar cache primeiro
    if (this.cache.has(src)) {
      this.applyMedia(element, this.cache.get(src))
      return
    }

    this.loadingQueue.add(element)
    
    // Esperar slot disponível
    while (this.loadingCount >= this.options.maxConcurrent) {
      await this.wait(50)
    }

    this.loadingCount++
    element.classList.add('loading')

    try {
      const mediaData = await this.fetchMedia(src)
      this.cache.set(src, mediaData)
      this.applyMedia(element, mediaData)
    } catch (error) {
      this.handleError(element, error)
    } finally {
      this.loadingCount--
      this.loadingQueue.delete(element)
      element.classList.remove('loading')
    }
  }

  async fetchMedia(src) {
    let lastError
    
    for (let attempt = 1; attempt <= this.options.retryAttempts; attempt++) {
      try {
        // Para imagens, usar preload
        if (this.isImage(src)) {
          return await this.preloadImage(src)
        }
        
        // Para outros tipos, fetch direto
        const response = await fetch(src)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        
        const blob = await response.blob()
        return URL.createObjectURL(blob)
        
      } catch (error) {
        lastError = error
        if (attempt < this.options.retryAttempts) {
          await this.wait(1000 * attempt) // Backoff exponencial
        }
      }
    }
    
    throw lastError
  }

  preloadImage(src) {
    return new Promise((resolve, reject) => {
      const img = this.getAvailableImage()
      
      img.onload = () => {
        resolve(src) // Para imagens, retornamos a URL original
      }
      
      img.onerror = () => {
        reject(new Error('Image load failed'))
      }
      
      img.src = src
    })
  }

  getAvailableImage() {
    // Reutilizar objetos Image para economia de memória
    return this.imagePool.find(img => !img.src) || new Image()
  }

  applyMedia(element, mediaSrc) {
    if (element.tagName === 'IMG') {
      element.src = mediaSrc
      element.classList.add('loaded')
      
      // Fade in effect
      element.style.opacity = '0'
      element.style.transition = 'opacity 0.3s'
      
      setTimeout(() => {
        element.style.opacity = '1'
      }, 50)
      
    } else if (element.dataset.type === 'background') {
      element.style.backgroundImage = `url(${mediaSrc})`
      element.classList.add('loaded')
    }
  }

  handleError(element, error) {
    console.warn('Erro ao carregar mídia:', error)
    
    element.classList.add('error')
    
    // Placeholder de erro
    if (element.tagName === 'IMG') {
      element.src = this.getErrorPlaceholder()
      element.alt = 'Erro ao carregar imagem'
    } else {
      element.innerHTML = '❌ Erro ao carregar'
    }
  }

  getErrorPlaceholder() {
    // SVG inline como placeholder de erro
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
      <svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f0f0f0"/>
        <text x="50%" y="50%" text-anchor="middle" dy="0.3em" fill="#999">❌</text>
      </svg>
    `)
  }

  // Progressive image loading (blur-up technique)
  setupProgressiveLoading(element) {
    const lowResSrc = element.dataset.srcLowRes
    const highResSrc = element.dataset.src
    
    if (!lowResSrc || !highResSrc) return

    // Carregar versão low-res imediatamente
    element.src = lowResSrc
    element.style.filter = 'blur(5px)'
    element.style.transition = 'filter 0.3s'
    
    // Preload high-res em background
    this.preloadImage(highResSrc).then(() => {
      element.src = highResSrc
      element.style.filter = 'none'
    }).catch(error => {
      console.warn('Erro ao carregar high-res:', error)
    })
  }

  // Auto-detect e setup de elementos lazy
  scanAndSetup(container = document) {
    // Imagens lazy
    const images = container.querySelectorAll('img[data-src]:not([data-lazy-setup])')
    images.forEach(img => {
      img.setAttribute('data-lazy-setup', 'true')
      
      // Configurar progressive loading se disponível
      if (img.dataset.srcLowRes) {
        this.setupProgressiveLoading(img)
      }
      
      this.observe(img)
    })

    // Backgrounds lazy
    const backgrounds = container.querySelectorAll('[data-bg-src]:not([data-lazy-setup])')
    backgrounds.forEach(el => {
      el.setAttribute('data-lazy-setup', 'true')
      el.dataset.src = el.dataset.bgSrc
      el.dataset.type = 'background'
      this.observe(el)
    })

    // Videos lazy
    const videos = container.querySelectorAll('video[data-src]:not([data-lazy-setup])')
    videos.forEach(video => {
      video.setAttribute('data-lazy-setup', 'true')
      this.observe(video)
    })
  }

  // Utility methods
  isImage(src) {
    return /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(src)
  }

  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // Performance monitoring
  getStats() {
    return {
      cacheSize: this.cache.size,
      loadingCount: this.loadingCount,
      queueSize: this.loadingQueue.size
    }
  }

  // Memory management
  clearCache() {
    // Liberar URLs de blob
    this.cache.forEach(url => {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url)
      }
    })
    this.cache.clear()
  }

  // Cleanup
  destroy() {
    if (this.observer) {
      this.observer.disconnect()
    }
    this.clearCache()
    this.imagePool = []
  }
}

// CSS para lazy loading
const lazyLoadingCSS = `
  .lazy {
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  
  .lazy.loaded {
    opacity: 1;
  }
  
  .lazy.loading {
    background: linear-gradient(90deg, #f0f0f0 25%, transparent 50%, #f0f0f0 75%);
    background-size: 200% 100%;
    animation: loading 1.5s infinite;
  }
  
  .lazy.error {
    opacity: 0.5;
    border: 1px dashed #ccc;
  }
  
  @keyframes loading {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  
  @media (prefers-reduced-motion: reduce) {
    .lazy {
      transition: none;
    }
  }
`

// Adicionar CSS
const style = document.createElement('style')
style.textContent = lazyLoadingCSS
document.head.appendChild(style)

// Auto-inicializar
let globalLazyLoader
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    globalLazyLoader = new LazyMediaLoader()
    globalLazyLoader.scanAndSetup()
  })
} else {
  globalLazyLoader = new LazyMediaLoader()
  globalLazyLoader.scanAndSetup()
}

// Export
window.LazyMediaLoader = LazyMediaLoader
window.lazyLoader = globalLazyLoader