"use strict";
/**
 * Backend para gerenciar Push Notifications
 * Sistema simplificado para PWA
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushService = exports.PushNotificationService = void 0;
exports.getPushApiRoutes = getPushApiRoutes;
// Configurar VAPID keys (gerar uma vez e manter)
const VAPID_KEYS = {
    publicKey: process.env.VAPID_PUBLIC_KEY || 'BH-QZ8DgQZr7F0LKOxbOCYNT8Q9ZyLbVL7x2y4iF-FaK0nPzV5xJ2rX3bF8G9DwS1mC6vT4N9WpR8uL3kY7Q5bA',
    privateKey: process.env.VAPID_PRIVATE_KEY || 'your-vapid-private-key-here'
};
class PushNotificationService {
    constructor() {
        this.subscriptions = new Map();
        this.init();
    }
    async init() {
        console.log('🔔 Push Notification Service inicializado');
    }
    // Configuração VAPID
    getVapidConfig() {
        return {
            vapidPublicKey: VAPID_KEYS.publicKey
        };
    }
    // Salvar subscrição do usuário
    async saveSubscription(userId, subscriptionData, userAgent) {
        try {
            const { endpoint, keys } = subscriptionData;
            const { p256dh, auth } = keys;
            const subscription = {
                userId,
                endpoint,
                p256dh,
                auth,
                userAgent: userAgent || '',
                active: true,
                createdAt: new Date(),
                updatedAt: new Date()
            };
            this.subscriptions.set(endpoint, subscription);
            console.log(`✅ Subscrição salva para usuário: ${userId}`);
            return true;
        }
        catch (error) {
            console.error('❌ Erro ao salvar subscrição:', error);
            return false;
        }
    }
    // Remover subscrição
    async removeSubscription(endpoint) {
        try {
            this.subscriptions.delete(endpoint);
            console.log(`✅ Subscrição removida: ${endpoint}`);
            return true;
        }
        catch (error) {
            console.error('❌ Erro ao remover subscrição:', error);
            return false;
        }
    }
    // Buscar subscrições de um usuário
    async getUserSubscriptions(userId) {
        try {
            const userSubs = [];
            this.subscriptions.forEach(sub => {
                if (sub.userId === userId && sub.active) {
                    userSubs.push(sub);
                }
            });
            return userSubs;
        }
        catch (error) {
            console.error('❌ Erro ao buscar subscrições:', error);
            return [];
        }
    }
    // Buscar todas as subscrições ativas
    async getAllActiveSubscriptions() {
        try {
            const activeSubs = [];
            this.subscriptions.forEach(sub => {
                if (sub.active) {
                    activeSubs.push(sub);
                }
            });
            return activeSubs;
        }
        catch (error) {
            console.error('❌ Erro ao buscar subscrições ativas:', error);
            return [];
        }
    }
    // Simular envio para um usuário específico
    async sendToUser(userId, payload) {
        try {
            const subscriptions = await this.getUserSubscriptions(userId);
            if (subscriptions.length === 0) {
                console.log(`⚠️ Nenhuma subscrição encontrada para usuário: ${userId}`);
                return false;
            }
            console.log(`📤 Simulando envio de notificação para ${subscriptions.length} dispositivos`);
            console.log(`� Payload:`, payload);
            return true;
        }
        catch (error) {
            console.error('❌ Erro ao enviar para usuário:', error);
            return false;
        }
    }
    // Templates de notificação
    createMessageNotification(fromUser, message, conversationId) {
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
        };
    }
    createSystemNotification(title, message, actionUrl = '/') {
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
        };
    }
    // Estatísticas
    async getStats() {
        const total = this.subscriptions.size;
        const active = Array.from(this.subscriptions.values()).filter(s => s.active).length;
        const inactive = total - active;
        return {
            total,
            active,
            inactive,
            activePercentage: total > 0 ? Math.round((active / total) * 100) : 0
        };
    }
}
exports.PushNotificationService = PushNotificationService;
// Instância singleton
exports.pushService = new PushNotificationService();
// Função helper para routes Express
function getPushApiRoutes() {
    return {
        // GET /api/push/config
        getConfig: (req, res) => {
            res.json(exports.pushService.getVapidConfig());
        },
        // POST /api/push/subscribe
        subscribe: async (req, res) => {
            try {
                const { subscription, userAgent } = req.body;
                const userId = req.user?.id || 'anonymous';
                const success = await exports.pushService.saveSubscription(userId, subscription, userAgent);
                if (success) {
                    res.json({ success: true, message: 'Subscrição salva' });
                }
                else {
                    res.status(500).json({ success: false, error: 'Erro ao salvar subscrição' });
                }
            }
            catch (error) {
                res.status(500).json({ success: false, error: 'Erro interno' });
            }
        },
        // POST /api/push/unsubscribe  
        unsubscribe: async (req, res) => {
            try {
                const { endpoint } = req.body;
                const success = await exports.pushService.removeSubscription(endpoint);
                if (success) {
                    res.json({ success: true, message: 'Subscrição removida' });
                }
                else {
                    res.status(500).json({ success: false, error: 'Erro ao remover subscrição' });
                }
            }
            catch (error) {
                res.status(500).json({ success: false, error: 'Erro interno' });
            }
        },
        // POST /api/push/send
        sendNotification: async (req, res) => {
            try {
                const { userId, payload } = req.body;
                const success = await exports.pushService.sendToUser(userId, payload);
                if (success) {
                    res.json({ success: true, message: 'Notificação enviada' });
                }
                else {
                    res.status(404).json({ success: false, error: 'Usuário não encontrado' });
                }
            }
            catch (error) {
                res.status(500).json({ success: false, error: 'Erro interno' });
            }
        },
        // GET /api/push/stats
        getStats: async (req, res) => {
            try {
                const stats = await exports.pushService.getStats();
                res.json(stats);
            }
            catch (error) {
                res.status(500).json({ error: 'Erro interno' });
            }
        }
    };
}
