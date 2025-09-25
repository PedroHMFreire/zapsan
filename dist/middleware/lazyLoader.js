"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.lazyLoadWrapper = lazyLoadWrapper;
exports.lazyLoadMessages = lazyLoadMessages;
exports.lazyLoadContacts = lazyLoadContacts;
exports.lazyLoadSessions = lazyLoadSessions;
exports.startMetaCacheCleaner = startMetaCacheCleaner;
const adaptiveConfig_1 = require("./adaptiveConfig");
// Cache para metadados (evita recálculos)
const metaCache = new Map();
const CACHE_TTL = 60000; // 1 minuto
function lazyLoadWrapper(dataFetcher, totalCounter, cacheKey) {
    return async (req, res) => {
        const startTime = Date.now();
        try {
            const config = (0, adaptiveConfig_1.getPaginationConfig)(req);
            const cursor = req.query.cursor;
            const requestedLimit = parseInt(req.query.limit) || config.messageLimit;
            const limit = Math.min(requestedLimit, config.maxLimit);
            // Verificar cache de metadados
            let cachedMeta = null;
            if (cacheKey && !cursor) {
                const cached = metaCache.get(cacheKey);
                if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
                    cachedMeta = cached.data;
                }
            }
            // Buscar dados principais
            const data = await dataFetcher(limit + 1, cursor); // +1 para detectar hasMore
            // Separar dados e detectar se há mais
            const hasMore = data.length > limit;
            const actualData = hasMore ? data.slice(0, limit) : data;
            // Calcular próximo cursor (usar o último item)
            let nextCursor;
            if (hasMore && actualData.length > 0) {
                const lastItem = actualData[actualData.length - 1];
                // Assumir que itens têm 'id' ou 'timestamp' para cursor
                nextCursor = lastItem.id || lastItem.timestamp || String(actualData.length);
            }
            // Buscar total se necessário (e não estiver em cache)
            let total;
            if (totalCounter && (!cursor || !cachedMeta)) {
                try {
                    total = await totalCounter();
                    // Cachear metadados se temos chave
                    if (cacheKey) {
                        metaCache.set(cacheKey, {
                            data: { total, timestamp: Date.now() },
                            timestamp: Date.now()
                        });
                    }
                }
                catch (error) {
                    // Total é opcional, continuar sem ele
                    console.warn('Failed to get total count:', error);
                }
            }
            else if (cachedMeta) {
                total = cachedMeta.total;
            }
            // Montar metadados
            const meta = {
                hasMore,
                nextCursor,
                total,
                loaded: actualData.length,
                remaining: total ? Math.max(0, total - (actualData.length + (cursor ? 1 : 0))) : undefined,
                adaptiveConfig: {
                    currentLimit: limit,
                    deviceType: req.deviceContext?.isMobile ? 'mobile' : 'desktop',
                    connectionType: req.deviceContext?.connectionType || 'unknown'
                }
            };
            const response = {
                data: actualData,
                meta,
                loadTime: Date.now() - startTime
            };
            res.json(response);
        }
        catch (error) {
            res.status(500).json({
                error: 'lazy_load_failed',
                message: error.message,
                loadTime: Date.now() - startTime
            });
        }
    };
}
// Wrapper especializado para mensagens
function lazyLoadMessages(sessionId = 'default') {
    return lazyLoadWrapper(async (limit, cursor) => {
        const { getMessages } = await Promise.resolve().then(() => __importStar(require('../wa')));
        const allMessages = getMessages(sessionId, limit * 2); // Pegar mais para implementar cursor
        // Implementar cursor simples baseado em índice
        if (cursor) {
            const startIndex = parseInt(cursor) || 0;
            return allMessages.slice(startIndex, startIndex + limit);
        }
        return allMessages.slice(0, limit);
    }, async () => {
        const { getMessages } = await Promise.resolve().then(() => __importStar(require('../wa')));
        const allMessages = getMessages(sessionId, 10000); // Limite alto para contar
        return allMessages.length;
    }, `messages-${sessionId}`);
}
// Wrapper especializado para contatos
function lazyLoadContacts() {
    return lazyLoadWrapper(async (limit, cursor) => {
        const { supa } = await Promise.resolve().then(() => __importStar(require('../db')));
        let query = supa
            .from('contacts')
            .select('jid, name, is_group, last_seen')
            .order('name')
            .limit(limit);
        if (cursor) {
            query = query.gt('name', cursor);
        }
        const { data, error } = await query;
        if (error)
            throw error;
        return data || [];
    }, async () => {
        const { supa } = await Promise.resolve().then(() => __importStar(require('../db')));
        const { count } = await supa
            .from('contacts')
            .select('*', { count: 'exact', head: true });
        return count || 0;
    }, 'contacts');
}
// Wrapper especializado para sessões
function lazyLoadSessions() {
    return lazyLoadWrapper(async (limit, cursor) => {
        const { supa } = await Promise.resolve().then(() => __importStar(require('../db')));
        let query = supa
            .from('user_sessions')
            .select('session_key, created_at, last_activity, status')
            .order('last_activity', { ascending: false })
            .limit(limit);
        if (cursor) {
            query = query.lt('last_activity', cursor);
        }
        const { data, error } = await query;
        if (error)
            throw error;
        return data || [];
    }, async () => {
        const { supa } = await Promise.resolve().then(() => __importStar(require('../db')));
        const { count } = await supa
            .from('user_sessions')
            .select('*', { count: 'exact', head: true });
        return count || 0;
    }, 'sessions');
}
// Limpar cache periodicamente
function startMetaCacheCleaner() {
    setInterval(() => {
        const now = Date.now();
        for (const [key, value] of metaCache.entries()) {
            if (now - value.timestamp > CACHE_TTL) {
                metaCache.delete(key);
            }
        }
    }, CACHE_TTL);
}
