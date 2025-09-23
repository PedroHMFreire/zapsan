"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
// Update the import to match the actual exported member names from './wa'
const wa_1 = require("./wa");
const supaUsers_1 = require("./supaUsers");
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
// === Auth & sessão por usuário ===
// /auth/register: cria novo usuário; /auth/login: apenas autentica (sem auto-criação) ou aceita legacy { user }
r.post('/auth/register', async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        const emailRaw = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        const confirm = String(req.body?.confirm || '');
        if (!emailRaw || !password)
            return res.status(400).json({ error: 'missing_fields' });
        if (password.length < 6)
            return res.status(400).json({ error: 'weak_password' });
        if (password !== confirm)
            return res.status(400).json({ error: 'password_mismatch' });
        const out = await (0, supaUsers_1.registerUser)(name, emailRaw, password);
        if (!out.ok) {
            const map = { user_exists: 409, supabase_signup_failed: 502 };
            const code = out.error ? (map[out.error] || 400) : 400;
            return res.status(code).json({ error: out.error || 'registration_failed' });
        }
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(out.userId);
        // dispara inicialização (não aguarda) para já preparar QR se necessário
        (0, wa_1.createOrLoadSession)(sessionId).catch(() => { });
        res.cookie('uid', out.userId, { httpOnly: true, sameSite: 'lax', secure: false });
        res.status(201).json({ ok: true, userId: out.userId, sessionId, created: out.created, sessionBoot: true });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
r.post('/auth/login', async (req, res) => {
    try {
        const legacyUser = String(req.body?.user || '').trim();
        const emailRaw = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        if (!emailRaw && !legacyUser)
            return res.status(400).json({ error: 'missing_credentials' });
        let userId = '';
        if (emailRaw) {
            const out = await (0, supaUsers_1.loginUser)(emailRaw, password);
            if (!out.ok) {
                const map = { invalid_credentials: 401, supabase_login_failed: 502 };
                const code = out.error ? (map[out.error] || 400) : 400;
                return res.status(code).json({ error: out.error || 'login_failed' });
            }
            userId = out.userId;
        }
        else {
            // legacy fallback
            userId = legacyUser;
        }
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(userId);
        // garante que a sessão será criada/carregada no primeiro login (lazy fire & forget)
        (0, wa_1.createOrLoadSession)(sessionId).catch(() => { });
        res.cookie('uid', userId, { httpOnly: true, sameSite: 'lax', secure: false });
        res.json({ ok: true, userId, sessionId, sessionBoot: true });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
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
        const manual = process.env.MANUAL_PAIRING === '1';
        if (manual) {
            (0, wa_1.createIdleSession)(sessionId);
            return res.status(201).json({ ok: true, status: 'idle', manual: true });
        }
        else {
            (0, wa_1.createOrLoadSession)(sessionId).catch(() => { });
            return res.status(202).json({ ok: true, status: 'creating', manual: false });
        }
    }
    catch (err) {
        return res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Inicia pairing manualmente (gera socket e QR)
r.post('/sessions/:id/start', async (req, res) => {
    try {
        if (process.env.MANUAL_PAIRING !== '1')
            return res.status(400).json({ error: 'not_manual_mode' });
        const { id } = req.params;
        const info = (0, wa_1.getDebug)(id);
        if (!info.exists)
            (0, wa_1.createIdleSession)(id);
        if (info.state && ['pairing', 'open'].includes(info.state))
            return res.status(409).json({ error: 'already_active', state: info.state });
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
// === DB-backed endpoints (Prisma) ===
// Upsert básico de usuário por phone (unique). Body: { phone, name? }
r.post('/users', async (req, res) => {
    try {
        const phone = String(req.body?.phone || '').trim();
        const name = req.body?.name ? String(req.body.name).trim() : undefined;
        if (!phone)
            return res.status(400).json({ error: 'missing_phone' });
        // Upsert: se existir atualiza name (quando fornecido), senão cria
        const user = await db_1.prisma.user.upsert({
            where: { phone },
            update: name ? { name } : {},
            create: { phone, name }
        });
        res.status(201).json({ ok: true, user });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Lista sessões associadas a um usuário (id do model User, não sessionId lógico)
r.get('/users/:id/sessions', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id)
            return res.status(400).json({ error: 'missing_id' });
        const sessions = await db_1.prisma.session.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' } });
        res.json({ sessions });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Mensagens persistidas no Postgres (paginação por cursor temporal decrescente)
// Query params: limit (default 50, max 200), before (timestamp ISO ou epoch ms) para paginação
r.get('/sessions/:id/messages/db', async (req, res) => {
    try {
        const { id } = req.params; // id aqui é session.sessionId lógico
        const limitRaw = Number(req.query.limit || 50);
        const limit = isNaN(limitRaw) ? 50 : Math.min(Math.max(limitRaw, 1), 200);
        const beforeRaw = String(req.query.before || '').trim();
        let beforeDate;
        if (beforeRaw) {
            // tenta parse epoch
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
        // Recupera Session.id interno a partir de sessionId lógico
        const session = await db_1.prisma.session.findUnique({ where: { sessionId: id }, select: { id: true } });
        if (!session)
            return res.status(404).json({ error: 'session_not_found' });
        const where = { sessionId: session.id };
        if (beforeDate) {
            where.timestamp = { lt: beforeDate };
        }
        const messages = await db_1.prisma.message.findMany({
            where,
            orderBy: { timestamp: 'desc' },
            take: limit,
        });
        // Próximo cursor é o menor timestamp retornado (para continuar paginação)
        let nextCursor = null;
        if (messages.length === limit) {
            const last = messages[messages.length - 1];
            nextCursor = last.timestamp.toISOString();
        }
        res.json({ messages, nextCursor, pageSize: messages.length });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Lista contatos de uma sessão persistidos
r.get('/sessions/:id/contacts', async (req, res) => {
    try {
        const { id } = req.params; // sessionId lógico
        const session = await db_1.prisma.session.findUnique({ where: { sessionId: id }, select: { id: true } });
        if (!session)
            return res.status(404).json({ error: 'session_not_found' });
        const contacts = await db_1.prisma.contact.findMany({
            where: { sessionId: session.id },
            orderBy: [{ name: 'asc' }, { jid: 'asc' }]
        });
        res.json({ contacts });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Enviar texto via WhatsApp
r.post('/messages/send', async (req, res) => {
    try {
        const { to, text } = req.body || {};
        const userId = (req.cookies?.uid) || String(req.body?.user || '');
        if (!userId)
            return res.status(401).json({ error: 'unauthenticated' });
        if (!to || !text) {
            return res.status(400).json({ error: 'bad_request', message: 'to e text são obrigatórios' });
        }
        const session_id = await (0, userSessions_1.getOrCreateUserSession)(userId);
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
        const uid = (req.cookies?.uid) || '';
        if (!uid)
            return res.status(401).json({ error: 'unauthenticated' });
        const sessionId = await (0, userSessions_1.getOrCreateUserSession)(uid);
        const usage = (0, usage_1.getUsage)(sessionId);
        const status = (0, wa_1.getSessionStatus)(sessionId);
        // Tenta buscar perfil no Supabase (name, plan) se integração ativa
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
        // fallback de plano local se nada veio do Supabase
        if (!plan) {
            const p = (0, usage_1.getPlan)(uid);
            plan = p?.name || 'Free';
        }
        res.json({ userId: uid, sessionId, name, plan, usage, session: status });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
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
    const out = await (0, wa_1.cleanLogout)(sessionId, { keepMessages: true });
    if (!out.ok)
        return res.status(404).json({ error: out.reason || 'not_found' });
    res.json({ ok: true, cleaned: true });
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
        const out = await (0, wa_1.cleanLogout)(id, { keepMessages: keep });
        if (!out.ok)
            return res.status(404).json({ error: out.reason || 'not_found' });
        res.json({ ok: true, cleaned: true, keptMessages: keep });
    }
    catch (err) {
        res.status(500).json({ error: 'internal_error', message: err?.message });
    }
});
// Mensagens recentes com filtros
r.get('/sessions/:id/messages', (req, res) => {
    try {
        const { id } = req.params;
        const limitRaw = Number(req.query.limit || 200);
        const limit = isNaN(limitRaw) ? 200 : Math.min(Math.max(limitRaw, 1), 1000);
        // Novo buffer já retorna ordenado por timestamp asc (assumido). Caso contrário ordenar aqui.
        const msgs = (0, wa_1.getMessages)(id, limit);
        return res.json({ messages: msgs });
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
// SSE stream em tempo real
r.get('/sessions/:id/stream', (req, res) => {
    const { id } = req.params;
    // Configuração de cabeçalhos SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write(':ok\n\n');
    // Envia estado inicial
    try {
        const state = (0, wa_1.getSessionStatus)(id);
        res.write(`event: status\n`);
        res.write(`data: ${JSON.stringify(state)}\n\n`);
        const recent = (0, wa_1.getMessages)(id, 50);
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
    req.on('close', () => { closed = true; try {
        unsub();
    }
    catch { } });
});
exports.default = r;
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
        .map(l => ({ method: Object.keys(l.route.methods)[0].toUpperCase(), path: l.route.path }));
    res.json({ routes });
});
