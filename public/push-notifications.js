/**
 * Sistema de Push Notifications para ZapSan PWA
 * Gerencia subscrições e notificações em tempo real
 */

class PushNotificationManager {
  constructor(options = {}) {
    this.options = {
      vapidPublicKey: null, // Será configurado pelo servidor
      enableSound: true,
      enableVibration: true,
      showBadge: true,
      autoSubscribe: false,
      ...options
    }
    
    this.subscription = null
    this.supported = this.checkSupport()
    this.permission = Notification.permission
    
    this.init()
  }

  checkSupport() {
    return (
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    )
  }

  async init() {
    if (!this.supported) {
      console.warn('❌ Push notifications não suportadas')
      return false
    }

    // Aguardar service worker estar pronto
    await this.waitForServiceWorker()
    
    // Carregar configurações do servidor
    await this.loadServerConfig()
    
    // Verificar subscrição existente
    await this.checkExistingSubscription()
    
    // Auto-subscribe se habilitado
    if (this.options.autoSubscribe && this.permission === 'default') {
      await this.requestPermission()
    }

    console.log('🔔 Push Notification Manager inicializado')
    return true
  }

  async waitForServiceWorker() {
    if ('serviceWorker' in navigator) {
      let registration = await navigator.serviceWorker.getRegistration()
      
      if (!registration) {
        // Registrar service worker se não existir
        registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/'
        })
        console.log('📝 Service Worker registrado')
      }

      // Aguardar estar ativo
      if (registration.installing) {
        await new Promise(resolve => {
          registration.installing.addEventListener('statechange', () => {
            if (registration.installing.state === 'activated') {
              resolve()
            }
          })
        })
      }

      this.swRegistration = registration
    }
  }

  async loadServerConfig() {
    try {
      const response = await fetch('/api/push/config')
      if (response.ok) {
        const config = await response.json()
        this.options.vapidPublicKey = config.vapidPublicKey
        console.log('⚙️ Configuração push carregada do servidor')
      }
    } catch (error) {
      console.warn('⚠️ Erro ao carregar config push:', error)
    }
  }

  async checkExistingSubscription() {
    try {
      this.subscription = await this.swRegistration.pushManager.getSubscription()
      
      if (this.subscription) {
        console.log('✅ Subscrição push existente encontrada')
        // Sincronizar com servidor
        await this.syncSubscriptionWithServer()
      }
    } catch (error) {
      console.warn('⚠️ Erro ao verificar subscrição:', error)
    }
  }

  async requestPermission() {
    if (!this.supported) return false

    try {
      this.permission = await Notification.requestPermission()
      
      if (this.permission === 'granted') {
        console.log('✅ Permissão para notificações concedida')
        await this.subscribe()
        return true
      } else {
        console.log('❌ Permissão para notificações negada')
        return false
      }
    } catch (error) {
      console.error('❌ Erro ao solicitar permissão:', error)
      return false
    }
  }

  async subscribe() {
    if (!this.supported || this.permission !== 'granted') return false

    try {
      if (!this.options.vapidPublicKey) {
        throw new Error('VAPID public key não configurada')
      }

      const subscription = await this.swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array(this.options.vapidPublicKey)
      })

      this.subscription = subscription
      console.log('✅ Subscrição push criada')

      // Enviar para servidor
      await this.sendSubscriptionToServer(subscription)
      
      return subscription
    } catch (error) {
      console.error('❌ Erro ao criar subscrição:', error)
      return false
    }
  }

  async unsubscribe() {
    if (!this.subscription) return true

    try {
      await this.subscription.unsubscribe()
      await this.removeSubscriptionFromServer()
      
      this.subscription = null
      console.log('✅ Subscrição push removida')
      return true
    } catch (error) {
      console.error('❌ Erro ao remover subscrição:', error)
      return false
    }
  }

  async sendSubscriptionToServer(subscription) {
    try {
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: subscription,
          userAgent: navigator.userAgent,
          timestamp: Date.now()
        })
      })

      if (response.ok) {
        console.log('✅ Subscrição enviada para servidor')
      } else {
        throw new Error(`HTTP ${response.status}`)
      }
    } catch (error) {
      console.error('❌ Erro ao enviar subscrição para servidor:', error)
    }
  }

  async syncSubscriptionWithServer() {
    if (!this.subscription) return

    try {
      const response = await fetch('/api/push/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: this.subscription.endpoint
        })
      })

      if (response.ok) {
        console.log('✅ Subscrição sincronizada com servidor')
      }
    } catch (error) {
      console.warn('⚠️ Erro ao sincronizar subscrição:', error)
    }
  }

  async removeSubscriptionFromServer() {
    if (!this.subscription) return

    try {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: this.subscription.endpoint
        })
      })
      console.log('✅ Subscrição removida do servidor')
    } catch (error) {
      console.warn('⚠️ Erro ao remover subscrição do servidor:', error)
    }
  }

  // Mostrar notificação local
  showLocalNotification(title, options = {}) {
    if (this.permission !== 'granted') return false

    const notification = new Notification(title, {
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-badge.png',
      tag: 'zapsan-local',
      requireInteraction: false,
      silent: !this.options.enableSound,
      ...options
    })

    // Vibração se suportada e habilitada
    if (this.options.enableVibration && 'vibrate' in navigator) {
      navigator.vibrate([200, 100, 200])
    }

    // Auto-fechar após 5 segundos
    setTimeout(() => {
      notification.close()
    }, 5000)

    return notification
  }

  // Configurar badge no ícone do app
  setBadge(count) {
    if ('setAppBadge' in navigator) {
      navigator.setAppBadge(count).catch(error => {
        console.warn('⚠️ Erro ao definir badge:', error)
      })
    }
  }

  clearBadge() {
    if ('clearAppBadge' in navigator) {
      navigator.clearAppBadge().catch(error => {
        console.warn('⚠️ Erro ao limpar badge:', error)
      })
    }
  }

  // Utility para converter VAPID key
  urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    
    const rawData = window.atob(base64)
    const outputArray = new Uint8Array(rawData.length)
    
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i)
    }
    
    return outputArray
  }

  // Status da subscrição
  getStatus() {
    return {
      supported: this.supported,
      permission: this.permission,
      subscribed: !!this.subscription,
      endpoint: this.subscription?.endpoint || null
    }
  }

  // Event listeners para mudanças
  onPermissionChange(callback) {
    // Polling para mudanças de permissão (não há evento nativo)
    setInterval(() => {
      const currentPermission = Notification.permission
      if (currentPermission !== this.permission) {
        this.permission = currentPermission
        callback(currentPermission)
      }
    }, 1000)
  }

  onSubscriptionChange(callback) {
    if (this.swRegistration) {
      this.swRegistration.addEventListener('pushsubscriptionchange', callback)
    }
  }
}

// Interface de configuração de notificações
class NotificationSettings {
  constructor(pushManager) {
    this.pushManager = pushManager
    this.settings = this.loadSettings()
  }

  loadSettings() {
    const defaults = {
      enabled: true,
      sound: true,
      vibration: true,
      badge: true,
      newMessages: true,
      systemUpdates: true,
      marketing: false
    }

    try {
      const stored = localStorage.getItem('notification-settings')
      return stored ? { ...defaults, ...JSON.parse(stored) } : defaults
    } catch {
      return defaults
    }
  }

  saveSettings() {
    localStorage.setItem('notification-settings', JSON.stringify(this.settings))
    this.applySettings()
  }

  applySettings() {
    this.pushManager.options.enableSound = this.settings.sound
    this.pushManager.options.enableVibration = this.settings.vibration
    this.pushManager.options.showBadge = this.settings.badge

    // Enviar preferências para servidor
    fetch('/api/push/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.settings)
    }).catch(error => {
      console.warn('⚠️ Erro ao salvar preferências:', error)
    })
  }

  createUI() {
    return `
      <div class="notification-settings">
        <h3>🔔 Configurações de Notificação</h3>
        
        <div class="setting-group">
          <label>
            <input type="checkbox" ${this.settings.enabled ? 'checked' : ''} 
                   onchange="notificationSettings.toggle('enabled', this.checked)">
            Ativar notificações
          </label>
        </div>
        
        <div class="setting-group">
          <label>
            <input type="checkbox" ${this.settings.sound ? 'checked' : ''} 
                   onchange="notificationSettings.toggle('sound', this.checked)">
            Som
          </label>
        </div>
        
        <div class="setting-group">
          <label>
            <input type="checkbox" ${this.settings.vibration ? 'checked' : ''} 
                   onchange="notificationSettings.toggle('vibration', this.checked)">
            Vibração
          </label>
        </div>
        
        <div class="setting-group">
          <label>
            <input type="checkbox" ${this.settings.newMessages ? 'checked' : ''} 
                   onchange="notificationSettings.toggle('newMessages', this.checked)">
            Novas mensagens
          </label>
        </div>
        
        <div class="setting-group">
          <label>
            <input type="checkbox" ${this.settings.systemUpdates ? 'checked' : ''} 
                   onchange="notificationSettings.toggle('systemUpdates', this.checked)">
            Atualizações do sistema
          </label>
        </div>
      </div>
    `
  }

  toggle(setting, value) {
    this.settings[setting] = value
    this.saveSettings()
  }
}

// CSS para componente de configurações
const notificationCSS = `
  .notification-settings {
    padding: 20px;
    background: #f8f9fa;
    border-radius: 8px;
    margin: 10px 0;
  }
  
  .notification-settings h3 {
    margin-top: 0;
    color: #333;
  }
  
  .setting-group {
    margin: 15px 0;
    padding: 10px;
    background: white;
    border-radius: 5px;
    border: 1px solid #e0e0e0;
  }
  
  .setting-group label {
    display: flex;
    align-items: center;
    cursor: pointer;
  }
  
  .setting-group input[type="checkbox"] {
    margin-right: 10px;
    transform: scale(1.2);
  }
  
  .notification-permission-banner {
    background: #fff3cd;
    border: 1px solid #ffeaa7;
    color: #856404;
    padding: 15px;
    border-radius: 5px;
    margin: 10px 0;
    text-align: center;
  }
  
  .notification-permission-banner button {
    background: #25D366;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    margin: 5px;
    cursor: pointer;
  }
`

// Adicionar CSS
const style = document.createElement('style')
style.textContent = notificationCSS
document.head.appendChild(style)

// Auto-inicializar
let globalPushManager, notificationSettings

document.addEventListener('DOMContentLoaded', async () => {
  globalPushManager = new PushNotificationManager({
    autoSubscribe: false // Usuário deve optar por receber
  })
  
  notificationSettings = new NotificationSettings(globalPushManager)
  
  // Mostrar banner de permissão se necessário
  if (globalPushManager.permission === 'default') {
    showPermissionBanner()
  }
})

function showPermissionBanner() {
  const banner = document.createElement('div')
  banner.className = 'notification-permission-banner'
  banner.innerHTML = `
    <p>📱 Deseja receber notificações de novas mensagens?</p>
    <button onclick="enableNotifications()">Ativar</button>
    <button onclick="dismissPermissionBanner()">Agora não</button>
  `
  
  document.body.insertBefore(banner, document.body.firstChild)
}

async function enableNotifications() {
  const success = await globalPushManager.requestPermission()
  if (success) {
    showNotificationSuccess()
  }
  dismissPermissionBanner()
}

function dismissPermissionBanner() {
  const banner = document.querySelector('.notification-permission-banner')
  if (banner) {
    banner.remove()
  }
}

function showNotificationSuccess() {
  globalPushManager.showLocalNotification('🎉 Notificações ativadas!', {
    body: 'Você receberá notificações de novas mensagens'
  })
}

// Export global
window.PushNotificationManager = PushNotificationManager
window.NotificationSettings = NotificationSettings
window.pushManager = globalPushManager