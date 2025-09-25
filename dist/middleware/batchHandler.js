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
exports.registerBatchHandler = registerBatchHandler;
exports.batchHandler = batchHandler;
exports.registerCommonBatchHandlers = registerCommonBatchHandlers;
const adaptiveConfig_1 = require("./adaptiveConfig");
// Mapa de handlers permitidos para batch
const BATCH_HANDLERS = {};
// Registrar handler para um endpoint específico
function registerBatchHandler(pattern, handler) {
    BATCH_HANDLERS[pattern] = handler;
}
// Handler principal do batch
async function batchHandler(req, res) {
    const startTime = Date.now();
    try {
        const requests = req.body?.requests;
        if (!Array.isArray(requests)) {
            res.status(400).json({ error: 'invalid_batch_format', message: 'Expected array of requests' });
            return;
        }
        if (requests.length === 0) {
            res.status(400).json({ error: 'empty_batch', message: 'No requests provided' });
            return;
        }
        // Limite de operações em batch baseado no contexto
        const config = (0, adaptiveConfig_1.getPaginationConfig)(req);
        const maxBatchSize = req.deviceContext?.isMobile ? 5 : 10;
        if (requests.length > maxBatchSize) {
            res.status(400).json({
                error: 'batch_too_large',
                message: `Maximum ${maxBatchSize} operations allowed in batch`,
                limit: maxBatchSize
            });
            return;
        }
        const results = [];
        let errorCount = 0;
        // Processar cada operação
        for (const batchReq of requests) {
            const reqStart = Date.now();
            try {
                const result = await processBatchRequest(batchReq, req);
                results.push({
                    id: batchReq.id,
                    status: result.status,
                    data: result.data,
                    executionTime: Date.now() - reqStart
                });
            }
            catch (error) {
                errorCount++;
                results.push({
                    id: batchReq.id,
                    status: 500,
                    error: error.message || 'internal_error',
                    executionTime: Date.now() - reqStart
                });
            }
        }
        const totalTime = Date.now() - startTime;
        const batchResult = {
            results,
            totalTime,
            processed: requests.length,
            errors: errorCount
        };
        // Status baseado nos resultados
        const hasErrors = errorCount > 0;
        const allFailed = errorCount === requests.length;
        if (allFailed) {
            res.status(500).json(batchResult);
        }
        else if (hasErrors) {
            res.status(207).json(batchResult); // Multi-status
        }
        else {
            res.status(200).json(batchResult);
        }
    }
    catch (error) {
        res.status(500).json({
            error: 'batch_processing_failed',
            message: error.message,
            totalTime: Date.now() - startTime
        });
    }
}
// Processar uma requisição individual do batch
async function processBatchRequest(batchReq, originalReq) {
    const { endpoint, method, params, body } = batchReq;
    // Normalizar endpoint
    const normalizedEndpoint = endpoint.replace(/^\//, '');
    // Buscar handler apropriado
    let handler;
    for (const pattern in BATCH_HANDLERS) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '[^/]+') + '$');
        if (regex.test(normalizedEndpoint)) {
            handler = BATCH_HANDLERS[pattern];
            break;
        }
    }
    if (!handler) {
        throw new Error(`Endpoint not supported in batch: ${endpoint}`);
    }
    // Executar handler com contexto simulado
    const mockReq = {
        ...originalReq,
        params: params || {},
        body: body || {},
        query: params || {},
        method
    };
    let statusCode = 200;
    let responseData = null;
    const mockRes = {
        json: function (data) { responseData = data; return this; },
        status: function (code) { statusCode = code; return this; }
    };
    await handler(mockReq, mockRes);
    return {
        status: statusCode,
        data: responseData
    };
}
// Registrar handlers comuns
function registerCommonBatchHandlers() {
    // Handler para status de sessões
    registerBatchHandler('sessions/*/status', async (req, res) => {
        const { getStatus } = await Promise.resolve().then(() => __importStar(require('../wa')));
        try {
            const status = getStatus(req.params.id || req.params['0']);
            res.json(status);
        }
        catch (error) {
            res.status(404).json({ error: 'session_not_found' });
        }
    });
    // Handler para mensagens
    registerBatchHandler('sessions/*/messages', async (req, res) => {
        const { getMessages } = await Promise.resolve().then(() => __importStar(require('../wa')));
        const { getPaginationConfig } = await Promise.resolve().then(() => __importStar(require('./adaptiveConfig')));
        try {
            const sessionId = req.params.id || req.params['0'];
            const config = getPaginationConfig(req);
            const limit = Math.min(req.query.limit || config.messageLimit, config.maxLimit);
            const messages = getMessages(sessionId, limit);
            res.json({ messages, adaptive: { appliedLimit: limit } });
        }
        catch (error) {
            res.status(404).json({ error: 'session_not_found' });
        }
    });
    // Handler para contatos
    registerBatchHandler('me/contacts', async (req, res) => {
        const { supa } = await Promise.resolve().then(() => __importStar(require('../db')));
        const { getOrCreateUserSession } = await Promise.resolve().then(() => __importStar(require('../userSessions')));
        try {
            const uid = req.cookies?.uid;
            if (!uid) {
                res.status(401).json({ error: 'unauthenticated' });
                return;
            }
            const sessionId = await getOrCreateUserSession(uid);
            const { data } = await supa
                .from('contacts')
                .select('jid, name, is_group')
                .eq('session_key', sessionId)
                .order('name')
                .limit(50);
            res.json({ contacts: data || [] });
        }
        catch (error) {
            res.status(500).json({ error: 'fetch_failed' });
        }
    });
}
