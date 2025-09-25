"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
// Update the import to match the actual exported member names from './wa'
const wa_1 = require("./wa");
const mediaProcessor_1 = require("./mediaProcessor");
const supaUsers_1 = require("./supaUsers");
const userProfiles_1 = require("./userProfiles");
const multer_1 = __importDefault(require("multer"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const searchIndex_1 = require("./searchIndex");
const rateLimit_1 = require("./rateLimit");
const os_1 = __importDefault(require("os"));
// fs/path já importados acima
const knowledge_1 = require("./knowledge");
const userSessions_1 = require("./userSessions");
const usage_1 = require("./usage");
const db_1 = require("./db");
const bcrypt_1 = __importDefault(require("bcrypt"));
const userSessions_2 = require("./userSessions");
const supabase_1 = require("./supabase");
const adaptiveConfig_1 = require("./middleware/adaptiveConfig");
const batchHandler_1 = require("./middleware/batchHandler");
const lazyLoader_1 = require("./middleware/lazyLoader");
const performanceMonitor_1 = require("./middleware/performanceMonitor");
const pushNotifications_1 = require("./pushNotifications");
// === Simple JSON persistence helpers ===
const DATA_DIR = path_1.default.join(process.cwd(), 'data');
try {
    fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
}
catch { }
function readJson(file, fallback) {
    try {
        return JSON.parse(fs_1.default.readFileSync(path_1.default.join(DATA_DIR, file), 'utf8'));
    }
    catch {
        return fallback;
    }
}
function writeJson(file, value) {
    try {
        fs_1.default.writeFileSync(path_1.default.join(DATA_DIR, file), JSON.stringify(value, null, 2), 'utf8');
    }
    catch { }
}
// === In-memory stores (loaded at startup) ===
const flows = readJson('flows.json', []);
const schedules = readJson('schedules.json', []);
const tags = readJson('tags.json', {});
// === Schedule dispatcher ===
function scheduleDispatch(s) {
    const delay = new Date(s.when).getTime() - Date.now();
    if (delay <= 0)
        return; // past; will be handled manually if desired
    setTimeout(async () => {
        try {
            const manual = process.env.MANUAL_PAIRING === '1';
            if (manual) {
                const st = (0, wa_1.getStatus)(s.session_id);
                if (st.state !== 'open') {
                    s.status = 'failed';
                }
                else {
                    await (0, wa_1.sendText)(s.session_id, s.to, s.text);
                    s.status = 'sent';
                }
            }
            else {
                await (0, wa_1.createOrLoadSession)(s.session_id);
                await (0, wa_1.sendText)(s.session_id, s.to, s.text);
                s.status = 'sent';
            }
        }
        catch {
            s.status = 'failed';
        }
        finally {
            writeJson('schedules.json', schedules);
        }
    }, delay);
}
// Re-arm pending schedules on startup
schedules.filter(s => s.status === 'pending').forEach(scheduleDispatch);
// If 'createOrLoadSession' exists but is exported with a different name, import it accordingly:
// import { actualExportedName as createOrLoadSession, getQR, sendText } from './wa'
const r = (0, express_1.Router)();
// Diagnóstico de ambiente de autenticação (não expõe chaves reais)
r.get('/debug/auth-env', (_req, res) => {
    const flags = {
        hasSupabaseEnv: (0, supabase_1.hasSupabaseEnv)(),
        SUPABASE_URL_SET: !!process.env.SUPABASE_URL,
        SUPABASE_ANON_KEY_SET: !!process.env.SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY_SET: !!process.env.SUPABASE_SERVICE_ROLE_KEY
    };
    res.json(flags);
});
// Debug de configuração adaptativa
r.get('/debug/adaptive-config', (req, res) => {
    const deviceContext = req.deviceContext;
    const adaptiveConfig = req.adaptiveConfig;
    res.json({
        deviceContext,
        adaptiveConfig,
        timestamp: Date.now(),
        userAgent: req.headers['user-agent'],
        headers: {
            saveData: req.headers['save-data'],
            connection: req.headers.connection,
            rtt: req.headers.rtt,
            downlink: req.headers.downlink
        }
    });
});
// === Auth & sessão por usuário ===
// /auth/register: cria novo usuário; /auth/login: apenas autentica (sem auto-criação) ou aceita legacy { user }
// Novo registro baseado em email + password
r.post('/auth/register', async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const name = req.body?.name ? String(req.body.name).trim() : '';
        const password = String(req.body?.password || '');
        if (!email || !password)
            return res.status(400).json({ error: 'missing_fields' });
        if (password.length < 6)
            return res.status(400).json({ error: 'weak_password' });
        const hash = await bcrypt_1.default.hash(password, 10);
        const { data, error } = await db_1.supa.from('users').upsert({ email, name: name || null, passwordHash: hash }, { onConflict: 'email' }).select('id, email, name').single();
        if (error) {
            const msg = error.message || '';
            if (/duplicate|unique|23505/i.test(msg))
                return res.status(409).json({ error: 'user_exists' });
            return res.status(500).json({ error: 'registration_failed', detail: msg });
        }
        if (!data)
            return res.status(500).json({ error: 'registration_failed' });
        const userId = data.id;
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(userId);
        (0, wa_1.createOrLoadSession)(sessionId).catch(() => { });
        res.cookie('uid', userId, { httpOnly: true, sameSite: 'lax', secure: false });
        return res.status(201).json({ ok: true, user: data, sessionId });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Login baseado em email + password
r.post('/auth/login', async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        if (!email || !password)
            return res.status(400).json({ error: 'missing_credentials' });
        const { data: u, error } = await db_1.supa.from('users')
            .select('id, email, name, passwordHash')
            .eq('email', email)
            .single();
        if (error || !u || !u.passwordHash)
            return res.status(401).json({ error: 'invalid_credentials' });
        const ok = await bcrypt_1.default.compare(password, u.passwordHash);
        if (!ok)
            return res.status(401).json({ error: 'invalid_credentials' });
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(u.id);
        (0, wa_1.createOrLoadSession)(sessionId).catch(() => { });
        res.cookie('uid', u.id, { httpOnly: true, sameSite: 'lax', secure: false });
        return res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name }, sessionId, sessionBoot: true });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Retorna a sessão do usuário logado (por cookie ou query user)
r.get('/me/session', async (req, res) => {
    try {
        const uid = (req.cookies?.uid) || String(req.query.user || '');
        if (!uid)
            return res.status(401).json({ error: 'unauthenticated' });
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
        res.json({ userId: uid, sessionId });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
const upload = (0, multer_1.default)({ dest: path_1.default.join(process.cwd(), 'data', 'uploads') });
// Saúde do serviço
r.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
});
// Apaga todas as sessões (requer query confirm=1)
r.delete('/sessions', (req, res) => {
    if (String(req.query.confirm || '') !== '1') {
        return res.status(400).json({ error: 'confirmation_required', message: 'Use ?confirm=1 para confirmar exclusão de todas as sessões.' });
    }
    const out = (0, wa_1.nukeAllSessions)(); // já contém ok:true
    res.json({ ...out, wiped: true });
});
// Debug sessão
r.get('/sessions/:id/debug', (req, res) => {
    try {
        const info = (0, wa_1.getDebug)(req.params.id);
        return res.json(info);
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Knowledge base endpoints
r.get('/knowledge', (_req, res) => {
    const k = (0, knowledge_1.loadKnowledge)();
    res.json({ updatedAt: k.mtimeMs, content: k.raw });
});
r.put('/knowledge', (req, res) => {
    try {
        const content = String(req.body?.content || '');
        if (!content.trim())
            return res.status(400).json({ error: 'empty_content' });
        (0, knowledge_1.updateKnowledge)(content);
        const k = (0, knowledge_1.loadKnowledge)();
        res.json({ ok: true, updatedAt: k.mtimeMs });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
r.get('/knowledge/sections', (req, res) => {
    const q = String(req.query.q || '');
    const sections = (0, knowledge_1.selectSections)(q);
    res.json({ sections: sections.map(s => ({ heading: s.heading, content: s.content, index: s.index, score: s.score })) });
});
// Criar/inicializar sessão
r.post('/sessions/create', async (req, res) => {
    try {
        const sessionId = String(req.body?.session_id || '').trim();
        if (!sessionId) {
            return res.status(400).json({ error: 'bad_request', message: 'session_id obrigatório' });
        }
        // throttle per IP & global
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
        const allowed = (0, rateLimit_1.canCreateSession)(ip);
        if (!allowed.ok) {
            return res.status(429).json({ error: 'rate_limited', scope: allowed.reason });
        }
        // Nunca auto-gerar QR: criar sessão idle sempre
        (0, wa_1.createIdleSession)(sessionId);
        return res.status(201).json({ ok: true, status: 'idle', manual: process.env.MANUAL_PAIRING === '1' });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Inicia pairing manualmente (gera socket e QR)
r.post('/sessions/:id/start', async (req, res) => {
    try {
        const { id } = req.params;
        const info = (0, wa_1.getDebug)(id);
        if (!info.exists)
            (0, wa_1.createIdleSession)(id);
        if (info.state && ['pairing', 'open'].includes(info.state))
            return res.status(409).json({ error: 'already_active', state: info.state });
        // Autoriza start manual e inicia socket (vai gerar QR)
        (0, wa_1.allowManualStart)(id);
        await (0, wa_1.createOrLoadSession)(id);
        return res.json({ ok: true, started: true });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Regenera QR (reinicia socket se necessário) respeitando grace
r.post('/sessions/:id/qr/regenerate', async (req, res) => {
    try {
        if (process.env.MANUAL_PAIRING !== '1')
            return res.status(400).json({ error: 'not_manual_mode' });
        const { id } = req.params;
        const force = String(req.query.force || '') === '1';
        const dbg = (0, wa_1.getDebug)(id);
        if (!dbg.exists)
            return res.status(404).json({ error: 'not_found' });
        if (dbg.state === 'open')
            return res.status(400).json({ error: 'already_open' });
        if (dbg.scanGraceRemaining && dbg.scanGraceRemaining > 0 && !force) {
            return res.status(429).json({ error: 'grace_active', remaining: dbg.scanGraceRemaining });
        }
        // reinicia para forçar novo QR
        await (0, wa_1.createOrLoadSession)(id);
        return res.json({ ok: true, regenerating: true });
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
// Upsert básico de usuário por email (unique). Body: { email, name? }
r.post('/users', async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const name = req.body?.name ? String(req.body.name).trim() : null;
        if (!email)
            return res.status(400).json({ error: 'bad_request', message: 'email obrigatório' });
        const { data, error } = await db_1.supa.from('users').upsert({ email, name }, { onConflict: 'email' }).select('id, email, name').single();
        if (error) {
            const msg = error.message || '';
            if (/duplicate|unique|23505/i.test(msg)) {
                const { data: existing } = await db_1.supa.from('users').select('id, email, name').eq('email', email).single();
                return res.json({ ok: true, user: existing });
            }
            return res.status(500).json({ error: 'internal_error', detail: msg });
        }
        return res.status(201).json({ ok: true, user: data });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Vincula uma sessão existente (sessionId lógico) a um usuário
r.post('/users/:id/bind-session', async (req, res) => {
    try {
        const userId = String(req.params.id);
        const { session_id } = req.body || {};
        if (!session_id)
            return res.status(400).json({ error: 'bad_request', message: 'session_id obrigatório' });
        await (0, userSessions_2.setUserSession)(userId, String(session_id));
        return res.json({ ok: true });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Garante que a sessão (Baileys) do usuário exista e esteja inicializando em background
r.post('/users/:id/ensure-session', async (req, res) => {
    try {
        const userId = String(req.params.id);
        const { sessionId } = await (0, userSessions_2.ensureSessionStarted)(userId);
        return res.json({ ok: true, session_id: sessionId });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Lista sessões associadas a um usuário (id do model User, não sessionId lógico)
r.get('/users/:id/sessions', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id)
            return res.status(400).json({ error: 'missing_id' });
        const { data, error } = await db_1.supa.from('sessions')
            .select('*')
            .eq('user_id', id)
            .order('created_at', { ascending: false });
        if (error)
            return res.status(500).json({ error: 'internal_error', detail: error.message });
        res.json({ sessions: data || [] });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Mensagens persistidas no Postgres (paginação por cursor temporal decrescente)
// Query params: limit (adaptativo), before (timestamp ISO ou epoch ms) para paginação
r.get('/sessions/:id/messages/db', async (req, res) => {
    try {
        const { id } = req.params;
        // Usar configuração adaptativa
        const paginationConfig = (0, adaptiveConfig_1.getPaginationConfig)(req);
        const limitRaw = Number(req.query.limit || paginationConfig.defaultLimit);
        const limit = isNaN(limitRaw) ? paginationConfig.defaultLimit :
            Math.min(Math.max(limitRaw, 1), paginationConfig.maxLimit);
        const beforeRaw = String(req.query.before || '').trim();
        let beforeDate;
        if (beforeRaw) {
            const asNum = Number(beforeRaw);
            if (!isNaN(asNum) && asNum > 0) {
                beforeDate = new Date(asNum);
            }
            else {
                const d = new Date(beforeRaw);
                if (!isNaN(d.getTime()))
                    beforeDate = d;
            }
        }
        // Busca mensagens direto por session_key
        let query = db_1.supa.from('messages')
            .select('*')
            .eq('session_key', id)
            .order('timestamp', { ascending: false })
            .limit(limit);
        if (beforeDate) {
            query = query.lt('timestamp', beforeDate.toISOString());
        }
        const { data, error } = await query;
        if (error)
            return res.status(500).json({ error: 'internal_error', detail: error.message });
        let nextCursor = null;
        if (data && data.length === limit) {
            const last = data[data.length - 1];
            if (last?.timestamp)
                nextCursor = last.timestamp;
        }
        // Headers informativos sobre adaptação
        res.set('X-Adaptive-Limit', limit.toString());
        res.set('X-Max-Limit', paginationConfig.maxLimit.toString());
        res.json({
            messages: data || [],
            nextCursor,
            pageSize: data?.length || 0,
            adaptive: {
                appliedLimit: limit,
                maxLimit: paginationConfig.maxLimit,
                deviceOptimized: true
            }
        });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Lista contatos de uma sessão persistidos
r.get('/sessions/:id/contacts', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await db_1.supa.from('contacts')
            .select('*')
            .eq('session_key', id)
            .order('name', { ascending: true })
            .order('jid', { ascending: true });
        if (error)
            return res.status(500).json({ error: 'internal_error', detail: error.message });
        res.json({ contacts: data || [] });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Enviar texto via WhatsApp
r.post('/messages/send', async (req, res) => {
    console.log('[messages/send] Headers:', req.headers.cookie);
    console.log('[messages/send] Body:', req.body);
    try {
        const { to, text } = req.body || {};
        const userId = (req.cookies?.uid) || String(req.body?.user || '');
        console.log('[messages/send] userId extraído:', userId);
        if (!userId)
            return res.status(401).json({ error: 'unauthenticated' });
        if (!to || !text) {
            return res.status(400).json({ error: 'bad_request', message: 'to e text são obrigatórios' });
        }
        const session_id = await (0, userSessions_1.getOrCreateUserSession)(userId);
        console.log('[messages/send] session_id:', session_id);
        const quota = (0, usage_1.checkQuota)(userId, session_id);
        if (!quota.ok) {
            return res.status(429).json({ error: 'quota_exceeded', remaining: 0, plan: quota.plan });
        }
        const token = (0, rateLimit_1.takeSendToken)(String(session_id));
        if (!token.ok) {
            return res.status(429).json({ error: 'rate_limited', message: 'Limite de envio atingido. Aguarde.', remaining: token.remaining });
        }
        const manual = process.env.MANUAL_PAIRING === '1';
        if (manual) {
            const st = (0, wa_1.getStatus)(String(session_id));
            if (st.state !== 'open') {
                return res.status(409).json({ error: 'not_open', state: st.state });
            }
        }
        else {
            await (0, wa_1.createOrLoadSession)(String(session_id));
        }
        console.log('[messages/send] Chamando sendText...');
        await (0, wa_1.sendText)(String(session_id), String(to), String(text));
        (0, usage_1.recordMessage)(session_id);
        return res.json({ ok: true });
    }
    catch (err) {
        const code = err?.message === 'session_not_found' ? 404 : 500;
        return res.status(code).json({ error: err?.message || 'internal_error' });
    }
});
// === Perfil & sessão do usuário ===
r.get('/me', async (req, res) => {
    const uid = (req.cookies?.uid) || '';
    if (!uid)
        return res.status(401).json({ error: 'unauthenticated' });
    const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
    res.json({ userId: uid, sessionId });
});
r.get('/me/profile', async (req, res) => {
    try {
        const sessionQuery = String(req.query.session_id || '').trim();
        if (sessionQuery) {
            // Perfil baseado em session_id direto
            const { data: s, error: sErr } = await db_1.supa.from('sessions')
                .select('*')
                .eq('session_id', sessionQuery)
                .single();
            if (sErr || !s)
                return res.status(404).json({ error: 'not_found' });
            let userData = null;
            if (s.user_id) {
                const { data: usr } = await db_1.supa.from('users').select('id, email, name').eq('id', s.user_id).single();
                if (usr)
                    userData = usr;
            }
            return res.json({ sessionId: s.session_id, status: s.status, user: userData });
        }
        // Fluxo anterior (cookie uid)
        const uid = (req.cookies?.uid) || '';
        if (!uid)
            return res.status(401).json({ error: 'unauthenticated' });
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
        const usage = (0, usage_1.getUsage)(sessionId);
        const status = (0, wa_1.getSessionStatus)(sessionId);
        let name;
        let plan;
        try {
            const prof = await (0, supaUsers_1.fetchUserProfile)(uid);
            if (prof) {
                name = prof.name;
                plan = prof.plan || undefined;
            }
        }
        catch { }
        if (!plan) {
            const p = (0, usage_1.getPlan)(uid);
            plan = p?.name || 'Free';
        }
        return res.json({ userId: uid, sessionId, name, plan, usage, session: status });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
r.post('/me/logout', (req, res) => {
    res.clearCookie('uid');
    try {
        localStorageClearHint(res);
    }
    catch { }
    res.json({ ok: true });
});
// Proxy de QR da sessão do usuário
r.get('/me/session/qr', async (req, res) => {
    const uid = (req.cookies?.uid) || '';
    if (!uid)
        return res.status(401).json({ error: 'unauthenticated' });
    const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
    const qr = (0, wa_1.getQR)(sessionId);
    if (!qr)
        return res.status(404).json({ error: 'not_ready' });
    res.json({ dataUrl: qr });
});
r.post('/me/session/regen-qr', async (req, res) => {
    if (process.env.MANUAL_PAIRING !== '1')
        return res.status(400).json({ error: 'not_manual_mode' });
    const uid = (req.cookies?.uid) || '';
    if (!uid)
        return res.status(401).json({ error: 'unauthenticated' });
    const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
    // 🤖 === ROTAS DE CONTROLE DA IA ===
    // Toggle IA para sessão específica
    r.post('/sessions/:id/ai/toggle', async (req, res) => {
        try {
            const sessionId = req.params.id;
            const { enabled } = req.body;
            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ error: 'bad_request', message: 'Campo "enabled" deve ser true ou false' });
            }
            const result = (0, wa_1.toggleAI)(sessionId, enabled, req.body.userId);
            if (!result.ok) {
                return res.status(404).json({ error: 'session_not_found', message: result.message });
            }
            return res.json(result);
        }
        catch (err) {
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
    // Status da IA para sessão específica
    r.get('/sessions/:id/ai/status', async (req, res) => {
        try {
            const sessionId = req.params.id;
            const result = (0, wa_1.getAIStatus)(sessionId);
            if (!result.ok) {
                return res.status(404).json({ error: 'session_not_found', message: result.message });
            }
            return res.json(result);
        }
        catch (err) {
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
    // Toggle IA para a sessão do usuário logado
    r.post('/me/session/ai/toggle', async (req, res) => {
        try {
            const uid = (req.cookies?.uid) || '';
            if (!uid)
                return res.status(401).json({ error: 'unauthenticated' });
            const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
            const { enabled } = req.body;
            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ error: 'bad_request', message: 'Campo "enabled" deve ser true ou false' });
            }
            const result = (0, wa_1.toggleAI)(sessionId, enabled, uid);
            return res.json(result);
        }
        catch (err) {
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
    // Status da IA para a sessão do usuário logado
    r.get('/me/session/ai/status', async (req, res) => {
        try {
            const uid = (req.cookies?.uid) || '';
            if (!uid)
                return res.status(401).json({ error: 'unauthenticated' });
            const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
            const result = (0, wa_1.getAIStatus)(sessionId);
            return res.json(result);
        }
        catch (err) {
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
    // 👤 === ROTAS DE PERFIL DE USUÁRIO ===
    // Get user profile
    r.get('/me/profile', async (req, res) => {
        try {
            const uid = (req.cookies?.uid) || '';
            if (!uid)
                return res.status(401).json({ error: 'unauthenticated' });
            const profile = await (0, userProfiles_1.getUserProfile)(uid);
            return res.json({ profile });
        }
        catch (err) {
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
    // Update user profile
    r.post('/me/profile', async (req, res) => {
        try {
            const uid = (req.cookies?.uid) || '';
            if (!uid)
                return res.status(401).json({ error: 'unauthenticated' });
            const { botName, businessName, botTone, products, rules, memory } = req.body;
            const profile = await (0, userProfiles_1.createOrUpdateUserProfile)(uid, {
                botName,
                businessName,
                botTone,
                products: Array.isArray(products) ? products : [],
                rules: Array.isArray(rules) ? rules : [],
                memory: Array.isArray(memory) ? memory : []
            });
            return res.json({ profile });
        }
        catch (err) {
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
    // Get user knowledge base
    r.get('/me/knowledge', async (req, res) => {
        try {
            const uid = (req.cookies?.uid) || '';
            if (!uid)
                return res.status(401).json({ error: 'unauthenticated' });
            const knowledge = await (0, userProfiles_1.getUserKnowledge)(uid);
            return res.json({ knowledge });
        }
        catch (err) {
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
    // Update user knowledge base
    r.post('/me/knowledge', async (req, res) => {
        try {
            const uid = (req.cookies?.uid) || '';
            if (!uid)
                return res.status(401).json({ error: 'unauthenticated' });
            const { sections } = req.body;
            if (!Array.isArray(sections)) {
                return res.status(400).json({ error: 'bad_request', message: 'sections deve ser um array' });
            }
            const validSections = sections.filter(s => typeof s === 'object' &&
                typeof s.title === 'string' &&
                typeof s.content === 'string');
            if (validSections.length !== sections.length) {
                return res.status(400).json({ error: 'bad_request', message: 'Todas as seções devem ter title e content' });
            }
            const knowledge = await (0, userProfiles_1.updateUserKnowledge)(uid, validSections);
            return res.json({ knowledge });
        }
        catch (err) {
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
    // Initialize user data structure (for new users)
    r.post('/me/init', async (req, res) => {
        try {
            const uid = (req.cookies?.uid) || '';
            if (!uid)
                return res.status(401).json({ error: 'unauthenticated' });
            await (0, userProfiles_1.createUserDataStructure)(uid);
            // Create default profile if doesn't exist
            const existingProfile = await (0, userProfiles_1.getUserProfile)(uid);
            if (!existingProfile) {
                await (0, userProfiles_1.createOrUpdateUserProfile)(uid, {
                    botName: 'Meu Atendente',
                    businessName: 'Minha Empresa',
                    botTone: 'Vendedor consultivo e simpático',
                    products: ['Produto 1', 'Produto 2'],
                    rules: ['Seja prestativo e claro', 'Pergunte preferências do cliente'],
                    memory: ['Informação importante sobre o negócio']
                });
            }
            return res.json({ ok: true, message: 'Dados do usuário inicializados' });
        }
        catch (err) {
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
    try {
        await (0, wa_1.createOrLoadSession)(sessionId);
    }
    catch { }
    res.json({ ok: true, regenerating: true });
});
r.post('/me/session/clean', async (req, res) => {
    const uid = (req.cookies?.uid) || '';
    if (!uid)
        return res.status(401).json({ error: 'unauthenticated' });
    const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
    await (0, wa_1.cleanLogout)(sessionId, { keepMessages: true });
    res.json({ ok: true, cleaned: true });
});
// Buscar contatos salvos da sessão do usuário
r.get('/me/contacts', async (req, res) => {
    const uid = (req.cookies?.uid) || '';
    if (!uid)
        return res.status(401).json({ error: 'unauthenticated' });
    try {
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
        const { data: contacts, error } = await db_1.supa
            .from('contacts')
            .select('jid, name, is_group')
            .eq('session_key', sessionId)
            .order('name');
        if (error) {
            console.warn('[contacts][fetch][error]', error.message);
            return res.status(500).json({ error: 'database_error' });
        }
        res.json({ contacts: contacts || [] });
    }
    catch (err) {
        console.warn('[contacts][fetch][catch]', err?.message);
        res.status(500).json({ error: 'internal_error' });
    }
});
// Deletar contato específico da sessão do usuário
r.delete('/me/contacts/:jid', async (req, res) => {
    const uid = (req.cookies?.uid) || '';
    if (!uid)
        return res.status(401).json({ error: 'unauthenticated' });
    try {
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
        const jid = decodeURIComponent(req.params.jid);
        const { error } = await db_1.supa
            .from('contacts')
            .delete()
            .eq('session_key', sessionId)
            .eq('jid', jid);
        if (error) {
            console.warn('[contacts][delete][error]', error.message);
            return res.status(500).json({ error: 'database_error' });
        }
        res.json({ ok: true, deleted_jid: jid });
    }
    catch (err) {
        console.warn('[contacts][delete][catch]', err?.message);
        res.status(500).json({ error: 'internal_error' });
    }
});
// Buscar foto de perfil de um contato
r.get('/contacts/:jid/photo', async (req, res) => {
    const uid = (req.cookies?.uid) || '';
    if (!uid)
        return res.status(401).json({ error: 'unauthenticated' });
    try {
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
        const jid = decodeURIComponent(req.params.jid);
        const type = req.query.type === 'image' ? 'image' : 'preview'; // high or low res
        console.log(`Fetching profile picture for ${jid} (${type})`);
        const status = (0, wa_1.getSessionStatus)(sessionId);
        if (status.state !== 'open') {
            return res.status(400).json({
                error: 'whatsapp_not_connected',
                message: 'WhatsApp session not connected'
            });
        }
        try {
            const profileUrl = await (0, wa_1.getProfilePicture)(sessionId, jid, type);
            res.json({
                success: true,
                profileUrl
            });
        }
        catch (error) {
            console.warn('[photo][fetch][error]', error.message);
            res.status(500).json({
                error: 'fetch_error',
                message: error.message
            });
        }
    }
    catch (err) {
        console.warn('[photo][fetch][catch]', err?.message);
        res.status(500).json({ error: 'internal_error' });
    }
});
function localStorageClearHint(res) {
    // placeholder: em ambientes reais podemos instruir o frontend a limpar storage
    res.setHeader('X-Client-Clear-Storage', '1');
}
// Enviar mídia via upload multipart
r.post('/messages/media', upload.single('file'), async (req, res) => {
    try {
        const { session_id, to, caption } = req.body || {};
        if (!session_id || !to || !req.file)
            return res.status(400).json({ error: 'bad_request', message: 'session_id, to e file são obrigatórios' });
        const token = (0, rateLimit_1.takeSendToken)(String(session_id));
        if (!token.ok) {
            return res.status(429).json({ error: 'rate_limited', message: 'Limite de envio atingido. Aguarde.', remaining: token.remaining });
        }
        const manual = process.env.MANUAL_PAIRING === '1';
        if (manual) {
            const st = (0, wa_1.getStatus)(String(session_id));
            if (st.state !== 'open') {
                return res.status(409).json({ error: 'not_open', state: st.state });
            }
        }
        else {
            await (0, wa_1.createOrLoadSession)(String(session_id));
        }
        await (0, wa_1.sendMedia)(String(session_id), String(to), req.file.path, { caption });
        return res.json({ ok: true });
    }
    catch (err) {
        const code = err?.message === 'session_not_found' ? 404 : 500;
        return res.status(code).json({ error: err?.message || 'internal_error' });
    }
    finally {
        // Limpar arquivo temporário
        if (req.file?.path) {
            try {
                fs_1.default.unlinkSync(req.file.path);
            }
            catch { }
        }
    }
});
// Servir thumbnails de mídia
r.get('/media/thumbnail/:hash', (req, res) => {
    const hash = req.params.hash;
    const thumbnailPath = path_1.default.join(process.cwd(), 'data', 'media', 'thumbnails', hash);
    (0, mediaProcessor_1.serveMedia)(thumbnailPath, res);
});
// Servir previews de mídia
r.get('/media/preview/:hash', (req, res) => {
    const hash = req.params.hash;
    const previewPath = path_1.default.join(process.cwd(), 'data', 'media', 'previews', hash);
    (0, mediaProcessor_1.serveMedia)(previewPath, res);
});
// Servir mídia original
r.get('/media/original/:sessionId/:messageId', async (req, res) => {
    try {
        const { sessionId, messageId } = req.params;
        // Verificar autenticação (implementar se necessário)
        // const uid = await verifyUser(req)
        // if (!uid) return res.status(401).json({ error: 'unauthenticated' })
        // Buscar mensagem no store para obter caminho da mídia
        const messages = (0, wa_1.getMessages)(sessionId, 1000);
        const message = messages.find(m => m.id === messageId);
        if (!message || !message.mediaPath) {
            return res.status(404).json({ error: 'media_not_found' });
        }
        (0, mediaProcessor_1.serveMedia)(message.mediaPath, res);
    }
    catch (err) {
        console.warn('[media][original][serve][error]', err?.message);
        res.status(500).json({ error: 'serve_error' });
    }
});
// Status da sessão
r.get('/sessions/:id/status', (req, res) => {
    try {
        const { id } = req.params;
        return res.json((0, wa_1.getSessionStatus)(id));
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Metrics endpoint (JSON)
r.get('/metrics', (_req, res) => {
    try {
        const meta = (0, wa_1.getAllSessionMeta)();
        const rates = (0, rateLimit_1.snapshotRateState)();
        res.json({ time: Date.now(), host: os_1.default.hostname(), sessions: meta, rates });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Força reset da sessão (apaga diretório de credenciais) e reinicia -> novo QR
r.post('/sessions/:id/reset', async (req, res) => {
    try {
        const { id } = req.params;
        const sessDirRoot = process.env.SESS_DIR || path_1.default.resolve(process.cwd(), 'sessions');
        const baseDir = path_1.default.join(sessDirRoot, id);
        // apagar diretório se existir
        try {
            fs_1.default.rmSync(baseDir, { recursive: true, force: true });
        }
        catch { }
        // pequena espera opcional para garantir flush
        await new Promise(r => setTimeout(r, 50));
        (0, wa_1.createOrLoadSession)(id).catch(() => { });
        res.json({ ok: true, resetting: true });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Limpa sessão (logout e remove credenciais). Se keep=1 preserva mensagens em memória
r.post('/sessions/:id/clean', async (req, res) => {
    try {
        const { id } = req.params;
        const keep = String(req.query.keep || '') === '1';
        await (0, wa_1.cleanLogout)(id, { keepMessages: keep });
        res.json({ ok: true, cleaned: true, keptMessages: keep });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Mensagens recentes com filtros (adaptativo)
r.get('/sessions/:id/messages', (req, res) => {
    try {
        const { id } = req.params;
        // Usar configuração adaptativa para mensagens
        const paginationConfig = (0, adaptiveConfig_1.getPaginationConfig)(req);
        const limitRaw = Number(req.query.limit || paginationConfig.messageLimit);
        const limit = isNaN(limitRaw) ? paginationConfig.messageLimit :
            Math.min(Math.max(limitRaw, 1), paginationConfig.maxLimit);
        // Novo buffer já retorna ordenado por timestamp asc (assumido). Caso contrário ordenar aqui.
        const msgs = (0, wa_1.getMessages)(id, limit);
        // Headers informativos
        res.set('X-Adaptive-Message-Limit', limit.toString());
        return res.json({
            messages: msgs,
            adaptive: {
                appliedLimit: limit,
                messageLimit: paginationConfig.messageLimit,
                deviceOptimized: true
            }
        });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Busca textual (índice invertido em memória; sessão usada apenas para validar existência futura)
r.get('/sessions/:id/search', (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q)
            return res.status(400).json({ error: 'empty_query' });
        const limit = Number(req.query.limit || 20);
        const results = (0, searchIndex_1.search)(q, isNaN(limit) ? 20 : limit);
        return res.json({ results });
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// SSE stream em tempo real (com timeouts adaptativos)
r.get('/sessions/:id/stream', (req, res) => {
    const { id } = req.params;
    // Configuração adaptativa de timeout
    const timeoutConfig = (0, adaptiveConfig_1.getTimeoutConfig)(req);
    const sseTimeout = timeoutConfig.sseTimeout;
    // Configuração de cabeçalhos SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-SSE-Timeout': sseTimeout.toString()
    });
    res.write(':ok\n\n');
    // Timeout adaptativo para limpeza da conexão
    const timeoutHandle = setTimeout(() => {
        if (!closed) {
            res.write(`event: timeout\n`);
            res.write(`data: {"reason":"adaptive_timeout","timeout":${sseTimeout}}\n\n`);
            res.end();
            closed = true;
        }
    }, sseTimeout);
    // Envia estado inicial
    try {
        const state = (0, wa_1.getSessionStatus)(id);
        res.write(`event: status\n`);
        res.write(`data: ${JSON.stringify(state)}\n\n`);
        // Usar limite adaptativo para mensagens recentes
        const paginationConfig = (0, adaptiveConfig_1.getPaginationConfig)(req);
        const recent = (0, wa_1.getMessages)(id, paginationConfig.messageLimit);
        res.write(`event: recent\n`);
        res.write(`data: ${JSON.stringify(recent)}\n\n`);
    }
    catch { }
    let closed = false;
    const unsub = (0, wa_1.onMessageStream)(id, (m) => {
        if (closed)
            return;
        try {
            // Envia mensagem achatada para compatibilidade com front antigo (chat.html) que faz JSON.parse(ev.data) direto.
            // Mantemos um campo type para futuras distinções, mas colocamos os atributos no nível raiz.
            const payload = { type: 'message', ...m };
            res.write(`event: message\n`);
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
        catch { }
    });
    // Cleanup na desconexão
    req.on('close', () => {
        closed = true;
        clearTimeout(timeoutHandle);
        try {
            unsub();
        }
        catch { }
    });
});
// === Flows CRUD ===
r.get('/flows', (_req, res) => {
    res.json({ flows });
});
r.post('/flows', (req, res) => {
    try {
        const name = String(req.body?.name || '').trim() || 'Fluxo';
        const nodes = req.body?.nodes ?? [];
        const flow = { id: Date.now().toString(36), name, nodes };
        flows.push(flow);
        writeJson('flows.json', flows);
        res.status(201).json({ ok: true, flow });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
r.delete('/flows/:id', (req, res) => {
    const { id } = req.params;
    const idx = flows.findIndex(f => f.id === id);
    if (idx === -1)
        return res.status(404).json({ error: 'not_found' });
    flows.splice(idx, 1);
    writeJson('flows.json', flows);
    res.json({ ok: true });
});
// === Schedules ===
r.get('/schedules', (_req, res) => {
    res.json({ schedules });
});
r.post('/schedules', async (req, res) => {
    try {
        const { session_id, to, text, when } = req.body || {};
        if (!session_id || !to || !text || !when)
            return res.status(400).json({ error: 'bad_request' });
        const iso = new Date(when).toISOString();
        const sched = { id: Date.now().toString(36), session_id: String(session_id), to: String(to), text: String(text), when: iso, status: 'pending' };
        schedules.push(sched);
        writeJson('schedules.json', schedules);
        scheduleDispatch(sched);
        res.status(201).json({ ok: true, schedule: sched });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
r.delete('/schedules/:id', (req, res) => {
    const { id } = req.params;
    const idx = schedules.findIndex(s => s.id === id);
    if (idx === -1)
        return res.status(404).json({ error: 'not_found' });
    schedules.splice(idx, 1);
    writeJson('schedules.json', schedules);
    res.json({ ok: true });
});
// === Tags ===
r.get('/tags', (_req, res) => {
    res.json({ tags });
});
r.post('/tags', (req, res) => {
    try {
        const { message_id, label } = req.body || {};
        if (!message_id || !label)
            return res.status(400).json({ error: 'bad_request' });
        tags[String(message_id)] = String(label);
        writeJson('tags.json', tags);
        res.status(201).json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
r.delete('/tags/:id', (req, res) => {
    const { id } = req.params;
    if (!tags[id])
        return res.status(404).json({ error: 'not_found' });
    delete tags[id];
    writeJson('tags.json', tags);
    res.json({ ok: true });
});
// === Debug: lista rotas disponíveis (somente em dev) ===
r.get('/debug/routes', (_req, res) => {
    const stack = r.stack || [];
    const routes = stack
        .filter(l => l.route && l.route.path)
        .map(l => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
    res.json({ routes });
});
// ===== FASE 3: APIs OTIMIZADAS (BATCHING, LAZY LOADING, PERFORMANCE) =====
// Inicializar handlers de batch
(0, batchHandler_1.registerCommonBatchHandlers)();
// Endpoint de batching - múltiplas operações em uma requisição
r.post('/batch', batchHandler_1.batchHandler);
// Endpoints de lazy loading com metadados
r.get('/lazy/messages/:sessionId?', (req, res) => {
    const sessionId = req.params.sessionId || 'default';
    const handler = (0, lazyLoader_1.lazyLoadMessages)(sessionId);
    handler(req, res);
});
r.get('/lazy/contacts', (0, lazyLoader_1.lazyLoadContacts)());
r.get('/lazy/sessions', (0, lazyLoader_1.lazyLoadSessions)());
// Dashboard de performance e métricas
r.get('/performance', performanceMonitor_1.performanceHandler);
r.get('/performance/metrics', (_req, res) => {
    res.json((0, performanceMonitor_1.getCurrentMetrics)());
});
// Reset de métricas (útil para testes)
r.post('/performance/reset', (_req, res) => {
    (0, performanceMonitor_1.resetMetrics)();
    res.json({ ok: true, message: 'Metrics reset successfully' });
});
// Exemplo de uso do batch - endpoint para demonstração
r.get('/batch/example', (_req, res) => {
    res.json({
        description: 'Exemplo de uso do endpoint de batching',
        usage: {
            method: 'POST',
            url: '/api/batch',
            body: {
                requests: [
                    {
                        id: 'status_check',
                        method: 'GET',
                        endpoint: 'sessions/default/status',
                        params: {}
                    },
                    {
                        id: 'get_contacts',
                        method: 'GET',
                        endpoint: 'me/contacts',
                        params: { limit: 10 }
                    },
                    {
                        id: 'get_messages',
                        method: 'GET',
                        endpoint: 'sessions/default/messages',
                        params: { limit: 5 }
                    }
                ]
            }
        },
        advantages: [
            'Reduz número de requisições HTTP',
            'Otimizado para dispositivos móveis',
            'Processamento em batch eficiente',
            'Métricas de performance incluídas'
        ]
    });
});
// === Push Notifications API ===
const pushRoutes = (0, pushNotifications_1.getPushApiRoutes)();
r.get('/api/push/config', pushRoutes.getConfig);
r.post('/api/push/subscribe', pushRoutes.subscribe);
r.post('/api/push/unsubscribe', pushRoutes.unsubscribe);
r.post('/api/push/send', pushRoutes.sendNotification);
r.get('/api/push/stats', pushRoutes.getStats);
// Endpoint para sincronizar subscrições
r.post('/api/push/sync', async (req, res) => {
    try {
        res.json({ success: true, message: 'Subscrição sincronizada' });
    }
    catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});
exports.default = r;
