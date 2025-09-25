/**
 * Virtual Scrolling System para ZapSan
 * Suporta milhares de mensagens com performance 60fps
 */

class VirtualMessageScroller {
  constructor(container, options = {}) {
    this.container = container
    this.options = {
      itemHeight: 60, // Altura aproximada por mensagem
      buffer: 10,     // Items extras para render suave
      threshold: 100, // Distância para carregar mais
      ...options
    }
    
    this.items = []           // Todas as mensagens
    this.visibleItems = []    // Items atualmente renderizados
    this.startIndex = 0       // Primeiro item visível
    this.endIndex = 0         // Último item visível
    this.scrollTop = 0        // Posição atual do scroll
    this.isLoading = false    // Flag de carregamento
    
    this.init()
  }

  init() {
    this.setupContainer()
    this.setupScrollListener()
    this.setupResizeObserver()
  }

  setupContainer() {
    // Criar estrutura virtual
    this.viewport = document.createElement('div')
    this.viewport.className = 'virtual-viewport'
    this.viewport.style.cssText = `
      height: 100%;
      overflow-y: auto;
      position: relative;
      -webkit-overflow-scrolling: touch;
    `

    this.spacer = document.createElement('div')
    this.spacer.className = 'virtual-spacer'
    
    this.content = document.createElement('div')
    this.content.className = 'virtual-content'
    this.content.style.cssText = `
      position: relative;
      will-change: transform;
    `

    this.spacer.appendChild(this.content)
    this.viewport.appendChild(this.spacer)
    
    // Substituir conteúdo original
    this.container.innerHTML = ''
    this.container.appendChild(this.viewport)
  }

  setupScrollListener() {
    let ticking = false
    
    this.viewport.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          this.handleScroll()
          ticking = false
        })
        ticking = true
      }
    })
  }

  setupResizeObserver() {
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => {
        this.recalculate()
      })
      this.resizeObserver.observe(this.container)
    }
  }

  // Adicionar mensagens
  setItems(items) {
    this.items = items
    this.updateTotalHeight()
    this.render()
  }

  addItems(newItems) {
    this.items = [...this.items, ...newItems]
    this.updateTotalHeight()
    this.render()
  }

  prependItems(newItems) {
    const oldScrollHeight = this.spacer.scrollHeight
    this.items = [...newItems, ...this.items]
    this.updateTotalHeight()
    
    // Manter posição de scroll após adicionar items no topo
    const newScrollHeight = this.spacer.scrollHeight
    this.viewport.scrollTop += newScrollHeight - oldScrollHeight
    
    this.render()
  }

  updateTotalHeight() {
    const totalHeight = this.items.length * this.options.itemHeight
    this.spacer.style.height = `${totalHeight}px`
  }

  handleScroll() {
    this.scrollTop = this.viewport.scrollTop
    this.render()
    this.checkLoadMore()
  }

  render() {
    const containerHeight = this.viewport.clientHeight
    const scrollTop = this.scrollTop
    
    // Calcular range visível
    const startIndex = Math.floor(scrollTop / this.options.itemHeight)
    const endIndex = Math.min(
      startIndex + Math.ceil(containerHeight / this.options.itemHeight) + this.options.buffer,
      this.items.length - 1
    )

    // Ajustar com buffer
    this.startIndex = Math.max(0, startIndex - this.options.buffer)
    this.endIndex = Math.min(this.items.length - 1, endIndex + this.options.buffer)

    // Apenas re-renderizar se range mudou significativamente
    if (this.shouldRerender()) {
      this.renderVisibleItems()
    }
  }

  shouldRerender() {
    return Math.abs(this.lastStartIndex - this.startIndex) > this.options.buffer / 2 ||
           Math.abs(this.lastEndIndex - this.endIndex) > this.options.buffer / 2
  }

  renderVisibleItems() {
    this.lastStartIndex = this.startIndex
    this.lastEndIndex = this.endIndex
    
    // Limpar conteúdo anterior
    this.content.innerHTML = ''
    
    // Offset para posicionar items corretamente
    const offsetY = this.startIndex * this.options.itemHeight
    this.content.style.transform = `translateY(${offsetY}px)`
    
    // Renderizar items visíveis
    for (let i = this.startIndex; i <= this.endIndex; i++) {
      if (this.items[i]) {
        const element = this.renderItem(this.items[i], i)
        this.content.appendChild(element)
      }
    }
  }

  renderItem(item, index) {
    const element = document.createElement('div')
    element.className = `msg ${item.fromMe ? 'out' : 'in'}`
    element.style.cssText = `
      min-height: ${this.options.itemHeight}px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      margin: 2px 0;
    `
    
    // Usar template baseado no tipo de mensagem
    if (item.type === 'text') {
      element.innerHTML = `
        <div class="msg-content">${this.escapeHtml(item.text || '')}</div>
        <div class="meta">${this.formatTime(item.timestamp)} ${item.fromMe ? '✓' : ''}</div>
      `
    } else if (item.type === 'image') {
      element.innerHTML = `
        <div class="msg-media">
          <img src="${item.thumbnailUrl || '/placeholder.jpg'}" 
               data-src="${item.mediaUrl}" 
               class="msg-image lazy"
               loading="lazy" />
        </div>
        <div class="meta">${this.formatTime(item.timestamp)} ${item.fromMe ? '✓' : ''}</div>
      `
    }
    
    return element
  }

  // Lazy loading para próximas mensagens
  checkLoadMore() {
    const scrollBottom = this.viewport.scrollTop + this.viewport.clientHeight
    const totalHeight = this.spacer.scrollHeight
    
    // Se chegou perto do final, carregar mais
    if (!this.isLoading && scrollBottom > totalHeight - this.options.threshold) {
      this.loadMore()
    }
  }

  async loadMore() {
    if (this.isLoading || !this.onLoadMore) return
    
    this.isLoading = true
    this.showLoadingIndicator()
    
    try {
      const newItems = await this.onLoadMore()
      if (newItems && newItems.length > 0) {
        this.addItems(newItems)
      }
    } catch (error) {
      console.error('Erro ao carregar mais mensagens:', error)
    } finally {
      this.isLoading = false
      this.hideLoadingIndicator()
    }
  }

  showLoadingIndicator() {
    if (!this.loadingIndicator) {
      this.loadingIndicator = document.createElement('div')
      this.loadingIndicator.className = 'loading-indicator'
      this.loadingIndicator.innerHTML = '📨 Carregando mensagens...'
      this.loadingIndicator.style.cssText = `
        position: absolute;
        bottom: 10px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--wa-panel);
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 12px;
        color: var(--muted);
        z-index: 10;
      `
    }
    
    this.viewport.appendChild(this.loadingIndicator)
  }

  hideLoadingIndicator() {
    if (this.loadingIndicator && this.loadingIndicator.parentNode) {
      this.loadingIndicator.parentNode.removeChild(this.loadingIndicator)
    }
  }

  // Scroll para mensagem específica
  scrollToIndex(index, behavior = 'smooth') {
    const targetScrollTop = index * this.options.itemHeight
    this.viewport.scrollTo({
      top: targetScrollTop,
      behavior
    })
  }

  scrollToBottom(behavior = 'smooth') {
    this.viewport.scrollTo({
      top: this.spacer.scrollHeight,
      behavior
    })
  }

  // Recalcular após mudança de tamanho
  recalculate() {
    this.updateTotalHeight()
    this.render()
  }

  // Utility methods
  escapeHtml(text) {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // Cleanup
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
    }
    this.viewport.removeEventListener('scroll', this.handleScroll)
  }
}

// CSS para virtual scrolling
const virtualScrollCSS = `
  .virtual-viewport {
    contain: layout style paint;
  }
  
  .virtual-content {
    contain: layout;
  }
  
  .msg-image.lazy {
    background: var(--wa-border);
    min-height: 100px;
    object-fit: cover;
    border-radius: 8px;
    transition: opacity 0.3s;
  }
  
  .msg-image.loaded {
    background: none;
  }
  
  .loading-indicator {
    animation: pulse 1.5s infinite;
  }
  
  @keyframes pulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }
`

// Adicionar CSS
const style = document.createElement('style')
style.textContent = virtualScrollCSS
document.head.appendChild(style)

// Export
window.VirtualMessageScroller = VirtualMessageScroller