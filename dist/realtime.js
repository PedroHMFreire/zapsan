"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sseHandler = sseHandler;
exports.broadcast = broadcast;
const clients = new Map();
function sseHandler(req, res) {
    const { id } = req.params;
    const clientId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: ready\n`);
    res.write(`data: {"ok":true}\n\n`);
    const c = { id: clientId, res, sessionId: id };
    clients.set(clientId, c);
    req.on('close', () => {
        clients.delete(clientId);
    });
}
function broadcast(sessionId, event, payload) {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients.values()) {
        if (c.sessionId === sessionId) {
            try {
                c.res.write(data);
            }
            catch { }
        }
    }
}
