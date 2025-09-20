"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const wa_1 = require("./wa");
const r = (0, express_1.Router)();
// Saúde do serviço
r.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
});
// Criar/inicializar sessão
r.post('/sessions/create', async (req, res) => {
    try {
        const sessionId = String(req.body?.session_id || '').trim();
        if (!sessionId) {
            return res.status(400).json({ error: 'bad_request', message: 'session_id obrigatório' });
        }
        // dispara criação sem bloquear resposta
        (0, wa_1.createOrLoadSession)(sessionId).catch(() => { });
        return res.status(202).json({ ok: true, status: 'creating' });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Buscar QR (quando disponível)
r.get('/sessions/:id/qr', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const qr = (0, wa_1.getQR)(sessionId);
        if (!qr)
            return res.status(404).json({ error: 'not_ready' });
        return res.json({ dataUrl: qr });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Enviar texto via WhatsApp
r.post('/messages/send', async (req, res) => {
    try {
        const { session_id, to, text } = req.body || {};
        if (!session_id || !to || !text) {
            return res.status(400).json({ error: 'bad_request', message: 'session_id, to e text são obrigatórios' });
        }
        await (0, wa_1.createOrLoadSession)(String(session_id));
        await (0, wa_1.sendText)(String(session_id), String(to), String(text));
        return res.json({ ok: true });
    }
    catch (err) {
        const code = err?.message === 'session_not_found' ? 404 : 500;
        return res.status(code).json({ error: err?.message || 'internal_error' });
    }
});
exports.default = r;
