/**
 * Backend para gerenciar Push Notifications
 * Sistema simplificado para PWA
 */

interface PushSubscription {
  id?: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

interface PushPayload {
  title: string
  message: string
  icon?: string
  badge?: string
  tag?: string
  data?: any
  actions?: Array<{ action: string; title: string }>
  requireInteraction?: boolean
}

// Configurar VAPID keys (gerar uma vez e manter)
const VAPID_KEYS = {
  publicKey: process.env.VAPID_PUBLIC_KEY || 'BH-QZ8DgQZr7F0LKOxbOCYNT8Q9ZyLbVL7x2y4iF-FaK0nPzV5xJ2rX3bF8G9DwS1mC6vT4N9WpR8uL3kY7Q5bA',
  privateKey: process.env.VAPID_PRIVATE_KEY || 'your-vapid-private-key-here'
}

export class PushNotificationService {
  private subscriptions: Map<string, PushSubscription> = new Map()

  constructor() {
    this.init()
  }

  async init() {
    console.log('🔔 Push Notification Service inicializado')
  }

  // Configuração VAPID
  getVapidConfig() {
    return {
      vapidPublicKey: VAPID_KEYS.publicKey
    }
  }

  // Salvar subscrição do usuário
  async saveSubscription(userId: string, subscriptionData: any, userAgent?: string): Promise<boolean> {
    try {
      const { endpoint, keys } = subscriptionData
      const { p256dh, auth } = keys

      const subscription: PushSubscription = {
        userId,
        endpoint,
        p256dh,
        auth,
        userAgent: userAgent || '',
        active: true,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      this.subscriptions.set(endpoint, subscription)
      console.log(`✅ Subscrição salva para usuário: ${userId}`)
      return true
    } catch (error) {
      console.error('❌ Erro ao salvar subscrição:', error)
      return false
    }
  }

  // Remover subscrição
  async removeSubscription(endpoint: string): Promise<boolean> {
    try {
      this.subscriptions.delete(endpoint)
      console.log(`✅ Subscrição removida: ${endpoint}`)
      return true
    } catch (error) {
      console.error('❌ Erro ao remover subscrição:', error)
      return false
    }
  }

  // Buscar subscrições de um usuário
  async getUserSubscriptions(userId: string): Promise<PushSubscription[]> {
    try {
      const userSubs: PushSubscription[] = []
      this.subscriptions.forEach(sub => {
        if (sub.userId === userId && sub.active) {
          userSubs.push(sub)
        }
      })
      return userSubs
    } catch (error) {
      console.error('❌ Erro ao buscar subscrições:', error)
      return []
    }
  }

  // Buscar todas as subscrições ativas
  async getAllActiveSubscriptions(): Promise<PushSubscription[]> {
    try {
      const activeSubs: PushSubscription[] = []
      this.subscriptions.forEach(sub => {
        if (sub.active) {
          activeSubs.push(sub)
        }
      })
      return activeSubs
    } catch (error) {
      console.error('❌ Erro ao buscar subscrições ativas:', error)
      return []
    }
  }

  // Simular envio para um usuário específico
  async sendToUser(userId: string, payload: PushPayload): Promise<boolean> {
    try {
      const subscriptions = await this.getUserSubscriptions(userId)
      
      if (subscriptions.length === 0) {
        console.log(`⚠️ Nenhuma subscrição encontrada para usuário: ${userId}`)
        return false
      }

      console.log(`📤 Simulando envio de notificação para ${subscriptions.length} dispositivos`)
      console.log(`� Payload:`, payload)

      return true
    } catch (error) {
      console.error('❌ Erro ao enviar para usuário:', error)
      return false
    }
  }

  // Templates de notificação
  createMessageNotification(fromUser: string, message: string, conversationId: string): PushPayload {
    return {
      title: `Nova mensagem de ${fromUser}`,
      message: message.length > 100 ? message.substring(0, 100) + '...' : message,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-badge.png',
      tag: `message-${conversationId}`,
      data: {
        type: 'message',
        conversationId,
        fromUser,
        url: `/?conversation=${conversationId}`
      },
      actions: [
        { action: 'reply', title: 'Responder' },
        { action: 'view', title: 'Ver conversa' }
      ],
      requireInteraction: true
    }
  }

  createSystemNotification(title: string, message: string, actionUrl = '/'): PushPayload {
    return {
      title: `ZapSan: ${title}`,
      message,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-badge.png',
      tag: 'system',
      data: {
        type: 'system',
        url: actionUrl
      },
      requireInteraction: false
    }
  }

  // Estatísticas
  async getStats() {
    const total = this.subscriptions.size
    const active = Array.from(this.subscriptions.values()).filter(s => s.active).length
    const inactive = total - active

    return {
      total,
      active,
      inactive,
      activePercentage: total > 0 ? Math.round((active / total) * 100) : 0
    }
  }
}

// Instância singleton
export const pushService = new PushNotificationService()

// Função helper para routes Express
export function getPushApiRoutes() {
  return {
    // GET /api/push/config
    getConfig: (req: any, res: any) => {
      res.json(pushService.getVapidConfig())
    },

    // POST /api/push/subscribe
    subscribe: async (req: any, res: any) => {
      try {
        const { subscription, userAgent } = req.body
        const userId = req.user?.id || 'anonymous'

        const success = await pushService.saveSubscription(userId, subscription, userAgent)
        
        if (success) {
          res.json({ success: true, message: 'Subscrição salva' })
        } else {
          res.status(500).json({ success: false, error: 'Erro ao salvar subscrição' })
        }
      } catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno' })
      }
    },

    // POST /api/push/unsubscribe  
    unsubscribe: async (req: any, res: any) => {
      try {
        const { endpoint } = req.body
        
        const success = await pushService.removeSubscription(endpoint)
        
        if (success) {
          res.json({ success: true, message: 'Subscrição removida' })
        } else {
          res.status(500).json({ success: false, error: 'Erro ao remover subscrição' })
        }
      } catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno' })
      }
    },

    // POST /api/push/send
    sendNotification: async (req: any, res: any) => {
      try {
        const { userId, payload } = req.body
        
        const success = await pushService.sendToUser(userId, payload)
        
        if (success) {
          res.json({ success: true, message: 'Notificação enviada' })
        } else {
          res.status(404).json({ success: false, error: 'Usuário não encontrado' })
        }
      } catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno' })
      }
    },

    // GET /api/push/stats
    getStats: async (req: any, res: any) => {
      try {
        const stats = await pushService.getStats()
        res.json(stats)
      } catch (error) {
        res.status(500).json({ error: 'Erro interno' })
      }
    }
  }
}