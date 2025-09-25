/**
 * Mobile Touch & Gesture Handler para ZapSan
 * Implementa: swipe, long-press, pull-to-refresh, ripple effects
 */

class MobileGestureHandler {
  constructor() {
    this.init()
  }

  init() {
    this.setupRippleEffects()
    this.setupSwipeGestures()
    this.setupLongPress()
    this.setupPullToRefresh()
    this.setupVirtualKeyboard()
    this.setupHapticFeedback()
  }

  // Ripple effect nos botões
  setupRippleEffects() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('.btn, .icon-btn, .m-btn')
      if (!target) return

      this.createRipple(e, target)
      this.triggerHaptic('light')
    })
  }

  createRipple(event, element) {
    const rect = element.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    const ripple = document.createElement('div')
    ripple.style.cssText = `
      position: absolute;
      border-radius: 50%;
      background: rgba(255,255,255,0.4);
      pointer-events: none;
      transform: scale(0);
      animation: ripple 0.6s ease-out;
      left: ${x}px;
      top: ${y}px;
      width: 20px;
      height: 20px;
      margin-left: -10px;
      margin-top: -10px;
    `

    element.appendChild(ripple)
    setTimeout(() => ripple.remove(), 600)
  }

  // Swipe gestures para chat items
  setupSwipeGestures() {
    let startX, startY, startTime, element
    let swiping = false

    document.addEventListener('touchstart', (e) => {
      const chatItem = e.target.closest('.chat-item')
      if (!chatItem) return

      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      startTime = Date.now()
      element = chatItem
      swiping = false
    }, { passive: true })

    document.addEventListener('touchmove', (e) => {
      if (!element) return

      const currentX = e.touches[0].clientX
      const currentY = e.touches[0].clientY
      const deltaX = currentX - startX
      const deltaY = currentY - startY

      // Detectar swipe horizontal (não vertical scroll)
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
        if (!swiping) {
          swiping = true
          element.classList.add('swiping')
          this.triggerHaptic('light')
        }

        // Aplicar transformação com resistência
        const resistance = Math.abs(deltaX) > 100 ? 0.3 : 1
        const translateX = Math.max(-120, deltaX * resistance)
        element.style.transform = `translateX(${translateX}px)`

        // Mostrar ações quando swipe suficiente
        if (Math.abs(translateX) > 60) {
          this.showSwipeActions(element, deltaX < 0 ? 'left' : 'right')
        }
      }
    }, { passive: true })

    document.addEventListener('touchend', (e) => {
      if (!element || !swiping) return

      const endX = e.changedTouches[0].clientX
      const deltaX = endX - startX
      const duration = Date.now() - startTime
      const velocity = Math.abs(deltaX) / duration

      element.classList.remove('swiping')

      // Determinar ação baseada na distância e velocidade
      if (Math.abs(deltaX) > 80 || velocity > 0.5) {
        this.executeSwipeAction(element, deltaX < 0 ? 'left' : 'right')
        this.triggerHaptic('medium')
      } else {
        // Voltar ao normal
        element.style.transform = ''
      }

      element = null
      swiping = false
    }, { passive: true })
  }

  showSwipeActions(element, direction) {
    // Implementar indicadores visuais das ações disponíveis
    const actions = element.querySelector('.swipe-actions')
    if (actions) {
      actions.style.transform = direction === 'left' ? 'translateX(0)' : 'translateX(-100%)'
    }
  }

  executeSwipeAction(element, direction) {
    const chatId = element.dataset.chatId
    
    if (direction === 'left') {
      // Swipe left: marcar como favorito
      this.starChat(chatId)
      this.showToast('⭐ Conversa marcada como favorita')
    } else {
      // Swipe right: arquivar/deletar
      this.showSwipeContextMenu(element, chatId)
    }

    // Reset visual
    setTimeout(() => {
      element.style.transform = ''
    }, 200)
  }

  // Long press context menu
  setupLongPress() {
    let longPressTimer
    let element

    document.addEventListener('touchstart', (e) => {
      const target = e.target.closest('.chat-item, .msg')
      if (!target) return

      element = target
      longPressTimer = setTimeout(() => {
        this.showContextMenu(e, target)
        this.triggerHaptic('heavy')
      }, 500)
    })

    document.addEventListener('touchmove', () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
    })

    document.addEventListener('touchend', () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
    })
  }

  showContextMenu(event, target) {
    const menu = document.getElementById('context-menu') || this.createContextMenu()
    const rect = target.getBoundingClientRect()
    
    // Posicionar menu
    menu.style.left = `${event.touches[0].clientX - 90}px`
    menu.style.top = `${rect.top - 10}px`
    
    // Configurar ações baseado no tipo de elemento
    this.populateContextMenu(menu, target)
    
    menu.classList.add('show')
    
    // Fechar ao tocar fora
    setTimeout(() => {
      const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
          menu.classList.remove('show')
          document.removeEventListener('touchstart', closeHandler)
        }
      }
      document.addEventListener('touchstart', closeHandler)
    }, 100)
  }

  createContextMenu() {
    const menu = document.createElement('div')
    menu.id = 'context-menu'
    menu.className = 'context-menu'
    document.body.appendChild(menu)
    return menu
  }

  populateContextMenu(menu, target) {
    const isMessage = target.classList.contains('msg')
    const isChatItem = target.classList.contains('chat-item')
    
    let items = []
    
    if (isMessage) {
      items = [
        { icon: '📋', text: 'Copiar', action: 'copy' },
        { icon: '↩️', text: 'Responder', action: 'reply' },
        { icon: '⭐', text: 'Favoritar', action: 'star' },
        { icon: '🗑️', text: 'Deletar', action: 'delete', danger: true }
      ]
    } else if (isChatItem) {
      items = [
        { icon: '📌', text: 'Fixar', action: 'pin' },
        { icon: '⭐', text: 'Favoritar', action: 'star' },
        { icon: '🔇', text: 'Silenciar', action: 'mute' },
        { icon: '🗑️', text: 'Deletar', action: 'delete', danger: true }
      ]
    }

    menu.innerHTML = items.map(item => `
      <button class="context-menu-item ${item.danger ? 'danger' : ''}" 
              data-action="${item.action}"
              data-target="${target.dataset.chatId || target.dataset.messageId}">
        <span class="icon">${item.icon}</span>
        ${item.text}
      </button>
    `).join('')

    // Adicionar event listeners
    menu.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.action
        const targetId = e.currentTarget.dataset.target
        this.executeContextAction(action, targetId)
        menu.classList.remove('show')
      })
    })
  }

  executeContextAction(action, targetId) {
    switch (action) {
      case 'copy':
        this.copyMessage(targetId)
        break
      case 'reply':
        this.replyToMessage(targetId)
        break
      case 'star':
        this.starItem(targetId)
        break
      case 'delete':
        this.deleteItem(targetId)
        break
      case 'pin':
        this.pinChat(targetId)
        break
      case 'mute':
        this.muteChat(targetId)
        break
    }
  }

  // Pull to refresh
  setupPullToRefresh() {
    let startY = 0
    let pulling = false
    const threshold = 80
    
    const chatList = document.querySelector('.chat-list')
    if (!chatList) return

    // Criar indicador
    const indicator = document.createElement('div')
    indicator.className = 'ptr-indicator'
    indicator.innerHTML = '↓'
    chatList.parentNode.insertBefore(indicator, chatList)

    chatList.addEventListener('touchstart', (e) => {
      if (chatList.scrollTop === 0) {
        startY = e.touches[0].clientY
        pulling = true
      }
    })

    chatList.addEventListener('touchmove', (e) => {
      if (!pulling) return

      const currentY = e.touches[0].clientY
      const deltaY = currentY - startY

      if (deltaY > 0 && chatList.scrollTop === 0) {
        e.preventDefault()
        const pullDistance = Math.min(deltaY, threshold * 1.5)
        
        chatList.style.transform = `translateY(${pullDistance * 0.5}px)`
        
        if (pullDistance >= threshold) {
          indicator.classList.add('visible')
          indicator.innerHTML = '↻'
          this.triggerHaptic('light')
        } else {
          indicator.classList.remove('visible')
          indicator.innerHTML = '↓'
        }
      }
    })

    chatList.addEventListener('touchend', (e) => {
      if (!pulling) return
      
      const currentY = e.changedTouches[0].clientY
      const deltaY = currentY - startY

      if (deltaY >= threshold) {
        this.executeRefresh(indicator)
      }

      // Reset
      chatList.style.transform = ''
      pulling = false
    })
  }

  executeRefresh(indicator) {
    indicator.classList.add('loading')
    indicator.innerHTML = '⟳'
    this.triggerHaptic('medium')
    
    // Simular refresh - integrar com sua API
    setTimeout(() => {
      indicator.classList.remove('visible', 'loading')
      indicator.innerHTML = '↓'
      this.showToast('✅ Conversas atualizadas')
      
      // Recarregar dados
      if (window.loadChats) {
        window.loadChats()
      }
    }, 1500)
  }

  // Adaptações para teclado virtual
  setupVirtualKeyboard() {
    let initialViewHeight = window.innerHeight

    window.addEventListener('resize', () => {
      const currentViewHeight = window.innerHeight
      const heightDiff = initialViewHeight - currentViewHeight

      // Detectar abertura do teclado (redução > 150px)
      if (heightDiff > 150) {
        document.body.classList.add('keyboard-open')
        this.scrollToComposer()
      } else {
        document.body.classList.remove('keyboard-open')
      }
    })

    // Auto-scroll para composer quando foca
    document.addEventListener('focusin', (e) => {
      if (e.target.matches('.c-composer textarea, .c-composer input')) {
        setTimeout(() => this.scrollToComposer(), 300)
      }
    })
  }

  scrollToComposer() {
    const composer = document.querySelector('.c-composer')
    if (composer) {
      composer.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }

  // Haptic Feedback
  setupHapticFeedback() {
    // Verificar suporte
    this.hasHapticSupport = 'vibrate' in navigator
  }

  triggerHaptic(type = 'light') {
    if (!this.hasHapticSupport) return

    const patterns = {
      light: [10],
      medium: [20],
      heavy: [30, 10, 30]
    }

    navigator.vibrate(patterns[type] || patterns.light)
  }

  // Utility methods
  showToast(message, type = 'info') {
    const toast = document.createElement('div')
    toast.className = `toast show ${type}`
    toast.textContent = message
    document.body.appendChild(toast)

    setTimeout(() => {
      toast.classList.remove('show')
      setTimeout(() => toast.remove(), 250)
    }, 3000)
  }

  starChat(chatId) {
    // Implementar lógica de favoritar
    console.log('Star chat:', chatId)
  }

  copyMessage(messageId) {
    // Implementar cópia de mensagem
    console.log('Copy message:', messageId)
  }

  deleteItem(itemId) {
    // Implementar deleção com confirmação
    if (confirm('Tem certeza que deseja deletar?')) {
      console.log('Delete item:', itemId)
    }
  }
}

// CSS dinâmico para ripple animation
const rippleCSS = `
  @keyframes ripple {
    to {
      transform: scale(4);
      opacity: 0;
    }
  }
  
  .keyboard-open .c-messages {
    padding-bottom: 20px;
  }
  
  .keyboard-open .app {
    height: 100vh;
    overflow: hidden;
  }
`

// Adicionar CSS
const style = document.createElement('style')
style.textContent = rippleCSS
document.head.appendChild(style)

// Inicializar quando DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new MobileGestureHandler())
} else {
  new MobileGestureHandler()
}

// Export para uso global
window.MobileGestureHandler = MobileGestureHandler