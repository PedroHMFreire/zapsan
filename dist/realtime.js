"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sseHandler = sseHandler;
exports.broadcast = broadcast;
const clients = new Map();
// Throttling para evitar spam de broadcasts
const broadcastThrottle = new Map();
const BROADCAST_THROTTLE_MS = 100; // 100ms entre broadcasts para mesmo evento
function sseHandler(req, res) {
    const { id } = req.params;
    const clientId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders?.();
    res.write(`event: ready\n`);
    res.write(`data: {"ok":true}\n\n`);
    const c = { id: clientId, res, sessionId: id };
    clients.set(clientId, c);
    // Cleanup automático em caso de desconexão
    req.on('close', () => {
        clients.delete(clientId);
        console.log(`[sse] Client disconnected: ${clientId}`);
    });
    req.on('error', (err) => {
        clients.delete(clientId);
        console.warn(`[sse] Client error: ${clientId}`, err.message);
    });
}
function broadcast(sessionId, event, payload) {
    if (!sessionId || !event) {
        console.warn('[broadcast] Invalid parameters:', { sessionId, event });
        return;
    }
    // Throttling para evitar spam
    const throttleKey = `${sessionId}-${event}`;
    const now = Date.now();
    const lastBroadcast = broadcastThrottle.get(throttleKey) || 0;
    if (now - lastBroadcast < BROADCAST_THROTTLE_MS) {
        return; // Throttled
    }
    broadcastThrottle.set(throttleKey, now);
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    let sentCount = 0;
    let errorCount = 0;
    for (const [clientId, c] of clients.entries()) {
        if (c.sessionId === sessionId) {
            try {
                c.res.write(data);
                sentCount++;
            }
            catch (err) {
                errorCount++;
                // Remove cliente com conexão quebrada
                clients.delete(clientId);
                console.warn(`[broadcast] Removed broken client: ${clientId}`);
            }
        }
    }
    if (sentCount === 0 && errorCount === 0) {
        console.log(`[broadcast] No clients connected for session: ${sessionId}`);
    }
    else if (errorCount > 0) {
        console.warn(`[broadcast] Sent to ${sentCount} clients, ${errorCount} errors for session: ${sessionId}`);
    }
}
