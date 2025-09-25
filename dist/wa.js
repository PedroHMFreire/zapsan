"use strict";
// Mantém a API ORIGINAL do seu projeto:
//   createOrLoadSession(sessionId)
//   getQR(sessionId)
//   sendText(sessionId, to, text)
// Corrige especificamente: erro 515/401 com reset de sessão + usa versão mais recente do WA.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.allowManualStart = allowManualStart;
exports.createOrLoadSession = createOrLoadSession;
exports.createIdleSession = createIdleSession;
exports.getQR = getQR;
exports.sendText = sendText;
exports.getProfilePicture = getProfilePicture;
exports.sendMedia = sendMedia;
exports.getStatus = getStatus;
exports.getDebug = getDebug;
exports.getAllSessionMeta = getAllSessionMeta;
exports.cleanLogout = cleanLogout;
exports.nukeAllSessions = nukeAllSessions;
exports.getSessionStatus = getSessionStatus;
exports.getMessages = getMessages;
exports.onMessageStream = onMessageStream;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const baileys_2 = require("@whiskeysockets/baileys");
const pino_1 = __importDefault(require("pino"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const qrcode_1 = __importDefault(require("qrcode"));
const messageStore_1 = require("./messageStore");
const searchIndex_1 = require("./searchIndex");
const realtime_1 = require("./realtime");
const db_1 = require("./db");
const events_1 = require("events");
const mediaProcessor_1 = require("./mediaProcessor");
const persistentAuth_1 = require("./persistentAuth");
// Mantém comportamento antigo: pasta local "sessions".
// Em produção (ex.: Render) recomenda-se definir SESS_DIR para um caminho gravável/persistente (/data/sessions ou volume montado)
const SESS_DIR = process.env.SESS_DIR || path_1.default.resolve(process.cwd(), 'sessions');
// Garante existência imediata do diretório raiz e reporta (útil para diagnosticar ENOENT / read-only FS)
try {
    fs_1.default.mkdirSync(SESS_DIR, { recursive: true });
    // Log somente uma vez no boot
    // (console.log usado em vez de logger interno para aparecer cedo no Render)
    // eslint-disable-next-line no-console
    console.log('[wa][init] SESS_DIR', SESS_DIR);
}
catch (err) {
    // eslint-disable-next-line no-console
    console.error('[wa][init][error_mkdir]', SESS_DIR, err?.message);
}
// Wrapper com retry para lidar com condição rara de ENOENT em init auth state (FS lento ou remoção concorrente)
async function prepareAuthState(baseDir, sessionId) {
    let attempt = 0;
    while (attempt < 3) {
        try {
            ensureDir(baseDir);
            // Usar sistema persistente que tenta local primeiro, depois Supabase
            const persistentAuth = (0, persistentAuth_1.createPersistentAuthState)(sessionId);
            await persistentAuth.loadState();
            // Converter para formato esperado pelo Baileys
            const authState = {
                state: {
                    creds: persistentAuth.state.creds,
                    keys: persistentAuth.state.keys
                },
                saveCreds: async () => {
                    persistentAuth.state.creds = authState.state.creds;
                    persistentAuth.state.keys = authState.state.keys;
                    await persistentAuth.saveState();
                }
            };
            // Se não tem credenciais, usar useMultiFileAuthState padrão
            if (!authState.state.creds) {
                const standardAuth = await (0, baileys_1.useMultiFileAuthState)(baseDir);
                // Converter para nosso formato persistente
                authState.state = standardAuth.state;
                authState.saveCreds = async () => {
                    await standardAuth.saveCreds();
                    // Também salvar no Supabase
                    persistentAuth.state.creds = authState.state.creds;
                    persistentAuth.state.keys = authState.state.keys;
                    await persistentAuth.saveState();
                };
            }
            if (authState?.state?.creds) {
                console.warn('[wa][authstate][recovered]', { baseDir, attempt, hasCreds: !!authState.state.creds });
            }
            return authState;
        }
        catch (err) {
            attempt++;
            if (err.code === 'ENOENT') {
                console.warn('[wa][authstate][retry]', { baseDir, attempt, code: err.code });
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
            else {
                throw err;
            }
        }
    }
    throw new Error(`authstate_failed_after_${attempt}_attempts`);
}
const sessions = new Map();
const isManualMode = () => process.env.MANUAL_PAIRING === '1';
// Função para validar formato brasileiro obrigatório: 55 + DDD + 9 + 8 dígitos
function normalizeBrazilianPhone(phone) {
    // Remove todos os caracteres não numéricos
    const digits = phone.replace(/\D/g, '');
    // Deve ter exatamente 13 dígitos (55 + 2 DDD + 1 nono dígito + 8 números)
    if (digits.length !== 13) {
        throw new Error('Número deve ter 13 dígitos: 55 + DDD + 9 + 8 números');
    }
    // Deve começar com 55 (código do Brasil)
    if (!digits.startsWith('55')) {
        throw new Error('Número deve começar com 55 (código do Brasil)');
    }
    // Extrai DDD (dígitos 3 e 4)
    const ddd = digits.slice(2, 4);
    const dddNumber = parseInt(ddd);
    // Verifica se é um DDD válido (11-99)
    if (dddNumber < 11 || dddNumber > 99) {
        throw new Error('DDD inválido. Deve estar entre 11 e 99');
    }
    // Verifica se o 5º dígito é 9 (nono dígito obrigatório para celulares)
    const ninthDigit = digits[4];
    if (ninthDigit !== '9') {
        throw new Error('Número de celular deve ter o 9º dígito. Formato: 55 + DDD + 9 + 8 números');
    }
    // Se passou por todas as validações, retorna o número
    return digits;
}
const sessionState = new Map();
const sessionMsgs = new Map();
const sessionBus = new Map();
// Dedupe simples para evitar upsert repetido do mesmo contato
const contactsSeen = new Map();
function seenSetFor(id) {
    let s = contactsSeen.get(id);
    if (!s) {
        s = new Set();
        contactsSeen.set(id, s);
    }
    return s;
}
function busFor(id) { let b = sessionBus.get(id); if (!b) {
    b = new events_1.EventEmitter();
    b.setMaxListeners(100);
    sessionBus.set(id, b);
} return b; }
function pushMsg(sessionId, m) {
    const buf = sessionMsgs.get(sessionId) || [];
    buf.push(m);
    if (buf.length > 5000)
        buf.splice(0, buf.length - 5000);
    sessionMsgs.set(sessionId, buf);
    busFor(sessionId).emit('message', m);
}
// expõe no global opcionalmente (usado por getStatus se disponível)
;
global.sessions = global.sessions || sessions;
const ensureDir = (dir) => {
    try {
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
    catch { }
};
const nukeDir = (dir) => {
    try {
        fs_1.default.rmSync(dir, { recursive: true, force: true });
    }
    catch { }
};
// Helper: detecta se já existe credencial (pareado previamente)
function hasCreds(dir) {
    try {
        return fs_1.default.existsSync(path_1.default.join(dir, 'creds.json'));
    }
    catch {
        return false;
    }
}
// Sinalização de start manual: somente quando presente permitimos iniciar socket sem credenciais
const manualStartRequests = new Set();
function allowManualStart(sessionId) {
    manualStartRequests.add(sessionId);
    // Evita ficar preso indefinidamente; expira em 60s
    setTimeout(() => manualStartRequests.delete(sessionId), 60000);
}
function loadMeta(baseDir) {
    try {
        const p = path_1.default.join(baseDir, 'meta.json');
        const raw = fs_1.default.readFileSync(p, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function saveMeta(sess) {
    if (!sess?.baseDir)
        return;
    try {
        const p = path_1.default.join(sess.baseDir, 'meta.json');
        const data = {
            restartCount: sess.restartCount || 0,
            criticalCount: sess.criticalCount || 0,
            lastDisconnectCode: sess.lastDisconnectCode || null,
            lastOpenAt: sess.lastOpenAt || null,
            lastState: sess.lastState || null,
            hasQR: !!sess.qrDataUrl,
            updatedAt: Date.now()
        };
        fs_1.default.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
        sess.metaPersisted = true;
    }
    catch { }
}
// === API ORIGINAL ===
// Dispara/recupera a sessão; não muda a assinatura original
async function createOrLoadSession(sessionId) {
    if (!sessionId)
        throw new Error('session_id_required');
    const current = sessions.get(sessionId);
    if (current?.sock || current?.starting)
        return;
    const baseDir = path_1.default.join(SESS_DIR, sessionId);
    ensureDir(baseDir);
    // Verifica credenciais existentes e pedido manual
    const credsPresent = hasCreds(baseDir);
    const manualRequested = manualStartRequests.has(sessionId);
    // Upsert sessão status somente quando realmente vamos iniciar conexão
    if (credsPresent || manualRequested) {
        try {
            const { error } = await db_1.supa.from('sessions').upsert({ session_id: sessionId, status: 'connecting' }, { onConflict: 'session_id' });
            if (error)
                console.warn('[wa][supa][session_upsert_connecting][warn]', sessionId, error.message);
        }
        catch (err) {
            console.warn('[wa][supa][session_upsert_connecting][catch]', sessionId, err?.message);
        }
    }
    // Hidratar histórico persistido (se ainda não carregado em sessionMsgs)
    try {
        if (!sessionMsgs.get(sessionId)) {
            const dataFile = path_1.default.join(process.cwd(), 'data', 'messages', `${sessionId}.json`);
            if (fs_1.default.existsSync(dataFile)) {
                const raw = fs_1.default.readFileSync(dataFile, 'utf8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed.messages)) {
                    const restored = parsed.messages.map((m) => ({
                        id: String(m.id || ''),
                        from: String(m.from || ''),
                        to: m.to ? String(m.to) : undefined,
                        text: m.text ? String(m.text) : '',
                        fromMe: !!m.fromMe,
                        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now()
                    })).filter((x) => x.id && x.from);
                    if (restored.length) {
                        const MAX = 5000;
                        const slice = restored.slice(-MAX);
                        sessionMsgs.set(sessionId, slice);
                        // Reindexar (best-effort)
                        try {
                            slice.forEach(r => { try {
                                (0, searchIndex_1.indexMessage)({ id: r.id, from: r.from, to: r.to, text: r.text || '', timestamp: r.timestamp, fromMe: !!r.fromMe });
                            }
                            catch { } });
                        }
                        catch { }
                        console.log('[wa][hydrate]', sessionId, { restored: slice.length });
                    }
                }
            }
        }
    }
    catch (err) {
        console.warn('[wa][hydrate][error]', sessionId, err?.message);
    }
    // load persisted meta if exists
    const meta = loadMeta(baseDir);
    const manual = isManualMode();
    // Se não há credenciais e não foi solicitado manualmente, não iniciar para não gerar QR automaticamente
    if (!credsPresent && !manualRequested) {
        const prev = sessions.get(sessionId);
        sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: prev?.lastState || 'idle', restartCount: meta.restartCount || (current?.restartCount || 0), criticalCount: meta.criticalCount || (current?.criticalCount || 0), lastDisconnectCode: meta.lastDisconnectCode, lastOpenAt: meta.lastOpenAt, manualMode: manual, messages: prev?.messages || [] });
        sessionState.set(sessionId, 'closed');
        try {
            await db_1.supa.from('sessions').upsert({ session_id: sessionId, status: 'closed' }, { onConflict: 'session_id' });
        }
        catch { }
        return;
    }
    sessions.set(sessionId, { baseDir, starting: true, startingSince: Date.now(), qr: null, restartCount: meta.restartCount || (current?.restartCount || 0), criticalCount: meta.criticalCount || (current?.criticalCount || 0), lastDisconnectCode: meta.lastDisconnectCode, lastOpenAt: meta.lastOpenAt, manualMode: manual });
    sessionState.set(sessionId, 'connecting');
    const boot = async () => {
        const sess = sessions.get(sessionId);
        // Usa wrapper resiliente para reduzir risco de ENOENT inicial (principalmente em FS em rede ou após nukeDir simultâneo)
        const { state, saveCreds } = await prepareAuthState(baseDir, sessionId);
        // >>> Correção 1: usar sempre a versão correta do WhatsApp Web
        const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
        const sock = (0, baileys_1.default)({
            version,
            auth: state,
            printQRInTerminal: false, // seu front já consome o QR
            browser: ['Ubuntu', 'Chrome', '121'],
            keepAliveIntervalMs: 30000,
            // Controlado por env: SYNC_FULL_HISTORY=1 para puxar histórico ao conectar
            syncFullHistory: process.env.SYNC_FULL_HISTORY === '1',
            markOnlineOnConnect: false,
            logger: (0, pino_1.default)({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' }),
        });
        sess.sock = sock;
        // Consome o pedido manual (se existia)
        if (manualStartRequests.has(sessionId))
            manualStartRequests.delete(sessionId);
        sess.starting = false;
        sess.qr = null;
        if (!sess.messages)
            sess.messages = [];
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (u) => {
            try {
                console.log('[wa][update]', sessionId, { connection: u.connection, qr: !!u.qr, lastDisconnect: u?.lastDisconnect?.error?.message });
            }
            catch { }
            if (u.connection) {
                sess.lastState = u.connection;
                if (u.connection === 'open')
                    sessionState.set(sessionId, 'open');
                else if (u.connection === 'close')
                    sessionState.set(sessionId, 'closed');
                else if (u.connection === 'connecting')
                    sessionState.set(sessionId, 'connecting');
            }
            // QR handling
            if (u.qr) {
                try {
                    const dataUrl = await qrcode_1.default.toDataURL(u.qr, { margin: 0 });
                    const changed = dataUrl !== sess.qrDataUrl;
                    if (changed) {
                        sess.qr = dataUrl;
                        sess.qrDataUrl = dataUrl;
                        sess.lastQRAt = Date.now();
                        if (!sess.firstQRAt)
                            sess.firstQRAt = sess.lastQRAt;
                        sess.qrGenCount = (sess.qrGenCount || 0) + 1;
                        if (sess.manualMode) {
                            const grace = Number(process.env.SCAN_GRACE_MS || 20000);
                            sess.scanGraceUntil = Date.now() + grace;
                        }
                        console.warn('[wa][qr][new]', sessionId, { qrGenCount: sess.qrGenCount, sinceFirstMs: sess.firstQRAt ? Date.now() - sess.firstQRAt : null, manual: !!sess.manualMode });
                    }
                    if (!sess.manualMode) {
                        // Auto-reset condicional (apenas modo automático)
                        const maxQrEnv = Number(process.env.QR_MAX_BEFORE_RESET || 8);
                        const maxMsEnv = Number(process.env.QR_MAX_AGE_BEFORE_RESET || 120000);
                        const autoResetEnabled = maxQrEnv > 0 && maxMsEnv > 0;
                        if (autoResetEnabled && !sess.everOpened) {
                            const tookTooMany = (sess.qrGenCount || 0) >= maxQrEnv;
                            const tooOld = sess.firstQRAt && (Date.now() - sess.firstQRAt) > maxMsEnv;
                            if (tookTooMany || tooOld) {
                                console.warn('[wa][qr][auto-reset]', sessionId, { qrGenCount: sess.qrGenCount, msSinceFirst: sess.firstQRAt ? Date.now() - sess.firstQRAt : null, tookTooMany, tooOld });
                                try {
                                    nukeDir(sess.baseDir);
                                }
                                catch { }
                                const restartCount = (sess.restartCount || 0) + 1;
                                sessions.set(sessionId, { baseDir: sess.baseDir, starting: false, qr: null, lastState: 'restarting', restartCount, criticalCount: sess.criticalCount, qrDataUrl: null, nextRetryAt: Date.now() + 1500 });
                                setTimeout(() => createOrLoadSession(sessionId).catch(() => { }), 15000);
                                return;
                            }
                        }
                    }
                }
                catch {
                    sess.qr = null;
                    sess.qrDataUrl = null;
                }
            }
            if (u.connection === 'open') {
                // conectado: limpar QR
                sess.qr = null;
                sess.qrDataUrl = null;
                sess.criticalCount = 0;
                sess.lastOpenAt = Date.now();
                sess.everOpened = true;
                saveMeta(sess);
                // atualizar status no banco
                try {
                    const { error } = await db_1.supa.from('sessions').upsert({ session_id: sessionId, status: 'open' }, { onConflict: 'session_id' });
                    if (error)
                        console.warn('[wa][supa][session_status_open][warn]', sessionId, error.message);
                }
                catch (e) {
                    console.warn('[wa][supa][session_status_open][catch]', sessionId, e?.message);
                }
            }
            if (u.connection === 'close') {
                const code = u.lastDisconnect?.error?.output?.statusCode ||
                    u.lastDisconnect?.error?.status || 0;
                sess.lastDisconnectCode = code;
                saveMeta(sess);
                const isStreamErrored = code === 515 || u.lastDisconnect?.error?.message?.includes('Stream Errored');
                const isLoggedOut = code === 401 ||
                    u.lastDisconnect?.error?.output?.statusCode === baileys_1.DisconnectReason.loggedOut;
                // >>> Correção 2: em 515/401, resetar credenciais e re-parear
                if (!sess.manualMode && (isStreamErrored || isLoggedOut)) {
                    const crit = (sess.criticalCount || 0) + 1;
                    sess.criticalCount = crit;
                    // base backoff exponencial simples: 3s * 2^(crit-1), cap 30s
                    let base = Math.min(30000, 3000 * Math.pow(2, Math.max(0, crit - 1)));
                    // jitter 0–25%
                    const delay = Math.round(base * (1 + Math.random() * 0.25));
                    // Heurística: se NUNCA abriu (sem everOpened) e já deu 2x 515 -> nuke para forçar QR totalmente novo
                    const neverOpened = !sess.everOpened;
                    const shouldNuke = isLoggedOut || crit >= 3 || (neverOpened && crit >= 2) || crit > 6;
                    console.warn('[wa][disconnect-critical]', sessionId, { code, crit, delay, everOpened: !!sess.everOpened, willNuke: shouldNuke });
                    if (shouldNuke) {
                        try {
                            nukeDir(baseDir);
                        }
                        catch { }
                    }
                    const restartCount = (sess.restartCount || 0) + 1;
                    sessions.set(sessionId, { baseDir, starting: false, qr: sess.qr || null, lastState: 'restarting', qrDataUrl: sess.qrDataUrl || null, restartCount, criticalCount: sess.criticalCount, nextRetryAt: Date.now() + delay, lastDisconnectCode: sess.lastDisconnectCode, lastOpenAt: sess.lastOpenAt, everOpened: sess.everOpened });
                    const ns = sessions.get(sessionId);
                    if (ns)
                        saveMeta(ns);
                    setTimeout(() => createOrLoadSession(sessionId).catch(() => { }), delay);
                    return;
                }
                // outros motivos (timeout, rede etc) → tenta reconectar preservando auth
                // reconexão leve (rede): manter QR se ainda não conectou / útil para pairing
                if (!sess.manualMode) {
                    const lightDelay = 10000;
                    const restartCount = (sess.restartCount || 0) + 1;
                    sessions.set(sessionId, { baseDir, starting: false, qr: sess.qr || null, lastState: 'reconnecting', qrDataUrl: sess.qrDataUrl || null, restartCount, criticalCount: sess.criticalCount || 0, nextRetryAt: Date.now() + lightDelay, lastDisconnectCode: sess.lastDisconnectCode, lastOpenAt: sess.lastOpenAt });
                    const ns = sessions.get(sessionId);
                    if (ns)
                        saveMeta(ns);
                    setTimeout(() => createOrLoadSession(sessionId).catch(() => { }), lightDelay);
                }
                else {
                    // Modo manual: não reconectar automaticamente
                    sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: 'waiting_manual_retry', qrDataUrl: null, restartCount: sess.restartCount, criticalCount: sess.criticalCount, lastDisconnectCode: sess.lastDisconnectCode, manualMode: true });
                }
                // persistir status closed
                try {
                    const { error } = await db_1.supa.from('sessions').upsert({ session_id: sessionId, status: 'closed' }, { onConflict: 'session_id' });
                    if (error)
                        console.warn('[wa][supa][session_status_closed][warn]', sessionId, error.message);
                }
                catch (e) { /* silencioso */ }
            }
        });
        // Listener principal de mensagens
        sock.ev.on('messages.upsert', async ({ messages }) => {
            if (!messages?.length)
                return;
            for (const m of messages) {
                try {
                    const id = m.key?.id || String(Date.now());
                    const from = m.key?.remoteJid || '';
                    const fromMe = !!m.key?.fromMe;
                    // Verificar se tem mídia
                    const hasMedia = !!(m.message?.imageMessage ||
                        m.message?.videoMessage ||
                        m.message?.audioMessage ||
                        m.message?.documentMessage ||
                        m.message?.stickerMessage);
                    let text = m.message?.conversation
                        || m.message?.extendedTextMessage?.text
                        || m.message?.imageMessage?.caption
                        || m.message?.videoMessage?.caption
                        || '';
                    let mediaInfo = null;
                    // Processar mídia se existir
                    if (hasMedia && !fromMe) { // Processar mídias recebidas
                        try {
                            const buffer = await (0, baileys_2.downloadMediaMessage)(m, 'buffer', {});
                            if (buffer) {
                                // Salvar arquivo temporário
                                const tempDir = path_1.default.join(process.cwd(), 'data', 'temp');
                                fs_1.default.mkdirSync(tempDir, { recursive: true });
                                let extension = '.bin';
                                let mimetype = 'application/octet-stream';
                                if (m.message?.imageMessage) {
                                    mimetype = m.message.imageMessage.mimetype || 'image/jpeg';
                                    extension = mimetype.includes('png') ? '.png' :
                                        mimetype.includes('webp') ? '.webp' : '.jpg';
                                }
                                else if (m.message?.videoMessage) {
                                    mimetype = m.message.videoMessage.mimetype || 'video/mp4';
                                    extension = '.mp4';
                                }
                                else if (m.message?.audioMessage) {
                                    mimetype = m.message.audioMessage.mimetype || 'audio/ogg';
                                    extension = '.ogg';
                                }
                                else if (m.message?.documentMessage) {
                                    const doc = m.message.documentMessage;
                                    mimetype = doc.mimetype || 'application/octet-stream';
                                    extension = path_1.default.extname(doc.fileName || '') || '.bin';
                                }
                                const tempFilePath = path_1.default.join(tempDir, `${id}${extension}`);
                                fs_1.default.writeFileSync(tempFilePath, buffer);
                                // Processar mídia para gerar thumbnails
                                mediaInfo = await (0, mediaProcessor_1.processMedia)(tempFilePath, mimetype);
                                // Definir texto para mídia se não tiver caption
                                if (!text) {
                                    text = hasMedia ? `📎 ${mediaInfo.filename}` : '';
                                }
                            }
                        }
                        catch (mediaError) {
                            console.warn('[wa][media][process][warn]', sessionId, mediaError);
                            text = text || '📎 Mídia';
                        }
                    }
                    const to = fromMe ? (m.key?.participant || from) : undefined;
                    // Baileys timestamp vem em segundos (normalmente). Convertemos para ms apenas se parecer razoável.
                    let tsRaw = m.messageTimestamp ? Number(m.messageTimestamp) : (Date.now() / 1000);
                    if (tsRaw < 10000000000) { // heurística: se ainda em segundos
                        tsRaw = tsRaw * 1000;
                    }
                    const ts = Math.floor(tsRaw);
                    const msgObj = {
                        id, from, to, text, fromMe, timestamp: ts,
                        ...(mediaInfo && {
                            mediaType: mediaInfo.type,
                            mediaPath: mediaInfo.originalPath,
                            thumbnailPath: mediaInfo.thumbnailPath,
                            previewPath: mediaInfo.previewPath,
                            mediaInfo: {
                                type: mediaInfo.type,
                                mimetype: mediaInfo.mimetype,
                                size: mediaInfo.size,
                                width: mediaInfo.width,
                                height: mediaInfo.height,
                                duration: mediaInfo.duration,
                                filename: mediaInfo.filename
                            }
                        })
                    };
                    pushMsg(sessionId, msgObj);
                    // Auto-cadastro do contato no primeiro contato (leve e idempotente)
                    try {
                        if (!fromMe && from) {
                            const seen = seenSetFor(sessionId);
                            if (!seen.has(from)) {
                                seen.add(from);
                                const isGroup = from.endsWith('@g.us');
                                const numberOrJid = from.replace(/@.*/, '');
                                const provisionalName = isGroup ? null : (m.pushName || numberOrJid);
                                try {
                                    const { error } = await db_1.supa.from('contacts').upsert({ session_key: sessionId, jid: from, name: provisionalName, is_group: isGroup }, { onConflict: 'session_key,jid' });
                                    if (!error) {
                                        try {
                                            (0, realtime_1.broadcast)(sessionId, 'contact_upsert', { jid: from, name: provisionalName, is_group: isGroup });
                                        }
                                        catch { }
                                    }
                                }
                                catch { }
                            }
                        }
                    }
                    catch { }
                    // Persistir em disco e indexar para busca/histórico
                    try {
                        (0, messageStore_1.appendMessage)(sessionId, { ...msgObj, text, fromMe });
                    }
                    catch { }
                    try {
                        (0, searchIndex_1.indexMessage)({ id, from, to, text, timestamp: ts, fromMe });
                    }
                    catch { }
                    // Persistir em Postgres
                    try {
                        const waMsgId = id;
                        const jid = from;
                        const body = text || null;
                        // Converte timestamp ms para Date
                        const tsDate = new Date(ts);
                        // Supabase insert de mensagem
                        const { error: msgErr } = await db_1.supa.from('messages').insert({
                            session_key: sessionId,
                            jid,
                            wa_msg_id: waMsgId,
                            from_me: fromMe,
                            body: body,
                            timestamp: tsDate,
                            raw: m
                        });
                        if (msgErr) {
                            if (!/duplicate|unique/i.test(msgErr.message)) {
                                console.warn('[wa][supa][message_insert][warn]', sessionId, msgErr.message);
                            }
                        }
                    }
                    catch (e) {
                        // Evitar spam massivo: log só mensagem resumida
                        if (!/Unique constraint|Foreign key/.test(e?.message || '')) {
                            console.warn('[wa][prisma][message_create][warn]', sessionId, e?.message);
                        }
                    }
                }
                catch (err) {
                    try {
                        console.warn('[wa][messages.upsert][err]', sessionId, err && err.message);
                    }
                    catch { }
                }
            }
        });
        // Atualizações de status de mensagens (ex: recebida, lida)
        sock.ev.on('messages.update', (updates) => {
            for (const u of updates) {
                try {
                    const status = (u.update.status !== undefined) ? String(u.update.status) : undefined;
                    if (status) {
                        (0, messageStore_1.updateMessageStatus)(sessionId, u.key.id, status);
                        (0, realtime_1.broadcast)(sessionId, 'message_status', { id: u.key.id, status });
                    }
                    console.log('[wa][msg.update]', sessionId, u.key.id, status);
                }
                catch { }
            }
        });
        // Recebidos indicadores de recibo (delivered/read)
        sock.ev.on('message-receipt.update', (receipts) => {
            try {
                console.log('[wa][receipt]', sessionId, receipts.length);
            }
            catch { }
        });
        // Atualizações de chats (metadados) - útil para depuração
        sock.ev.on('chats.upsert', (chats) => {
            try {
                console.log('[wa][chats.upsert]', sessionId, chats.length);
            }
            catch { }
        });
        sock.ev.on('contacts.upsert', async (cts) => {
            try {
                console.log('[wa][contacts.upsert]', sessionId, cts.length);
            }
            catch { }
            try {
                for (const c of cts) {
                    try {
                        const { error: cErr } = await db_1.supa.from('contacts').upsert({ session_key: sessionId, jid: c.id, name: c.notify || c.name || null, is_group: false }, { onConflict: 'session_key,jid' });
                        if (cErr) { /* silencioso por item */ }
                    }
                    catch (e) { /* ignorar individuais */ }
                }
            }
            catch (e) {
                console.warn('[wa][prisma][contacts_upsert][warn]', sessionId, e?.message);
            }
        });
        sock.ev.on('chats.set', async (payload) => {
            const chats = payload?.chats || [];
            try {
                console.log('[wa][chats.set]', sessionId, chats.length);
            }
            catch { }
            try {
                for (const ch of chats) {
                    const isGroup = ch?.id?.endsWith?.('@g.us');
                    try {
                        const { error: cErr } = await db_1.supa.from('contacts').upsert({ session_key: sessionId, jid: ch.id, name: ch.name || ch.id, is_group: isGroup }, { onConflict: 'session_key,jid' });
                        if (cErr) { /* ignorar individuais */ }
                    }
                    catch (e) { /* ignorar individuais */ }
                }
            }
            catch (e) {
                console.warn('[wa][prisma][chats_set][warn]', sessionId, e?.message);
            }
        });
    };
    boot().catch(() => {
        sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: 'error_init', qrDataUrl: null });
    });
}
// Cria sessão em estado idle (apenas se não existir) - usado em modo manual
function createIdleSession(sessionId) {
    if (!sessionId)
        throw new Error('session_id_required');
    const existing = sessions.get(sessionId);
    if (existing)
        return { ok: true, existed: true };
    const baseDir = path_1.default.join(SESS_DIR, sessionId);
    ensureDir(baseDir);
    sessions.set(sessionId, { baseDir, manualMode: true, lastState: 'idle', messages: [] });
    return { ok: true, existed: false };
}
// === API ORIGINAL ===
function getQR(sessionId) {
    const s = sessions.get(sessionId);
    // Enquanto estiver em processos de conexão/reconexão, devolver último QR disponível
    if (!s)
        return null;
    if (s.qr)
        return s.qr;
    return null;
}
// === API ORIGINAL ===
async function sendText(sessionId, to, text) {
    const s = sessions.get(sessionId);
    if (!s?.sock)
        throw new Error('session_not_found');
    let jid;
    if (to.includes('@s.whatsapp.net') || to.includes('@g.us')) {
        jid = to;
    }
    else {
        try {
            // Valida formato brasileiro obrigatório: 55 + DDD + 9 + 8 dígitos
            const normalizedPhone = normalizeBrazilianPhone(to);
            jid = `${normalizedPhone}@s.whatsapp.net`;
        }
        catch (error) {
            console.log(`[sendText] ❌ Erro de validação: ${error.message}`);
            throw new Error(`Formato de número inválido: ${error.message}`);
        }
    }
    console.log(`[sendText] Original: ${to} → Normalizado: ${jid}`);
    console.log(`[sendText] Enviando para ${jid}: ${text}`);
    try {
        await s.sock.sendMessage(jid, { text });
        console.log(`[sendText] ✅ Mensagem enviada com sucesso para ${jid}`);
    }
    catch (error) {
        console.error(`[sendText] ❌ Erro ao enviar para ${jid}:`, error.message);
        throw error;
    }
}
// Buscar foto de perfil de um contato
async function getProfilePicture(sessionId, jid, type = 'preview') {
    const s = sessions.get(sessionId);
    if (!s?.sock)
        throw new Error('session_not_found');
    try {
        const profileUrl = await s.sock.profilePictureUrl(jid, type);
        return profileUrl || null;
    }
    catch (error) {
        // Se não existe foto de perfil, Baileys retorna erro 404
        if (error.output?.statusCode === 404 || error.message?.includes('item-not-found')) {
            return null;
        }
        throw error;
    }
}
// Envio de mídia genérico
async function sendMedia(sessionId, to, filePath, options) {
    const s = sessions.get(sessionId);
    if (!s?.sock)
        throw new Error('session_not_found');
    const jid = to.includes('@s.whatsapp.net') || to.includes('@g.us')
        ? to
        : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
    // Processar mídia primeiro para gerar thumbnails
    let mediaInfo;
    try {
        const mimetype = options.mimetype || require('mime-types').lookup(filePath) || 'application/octet-stream';
        mediaInfo = await (0, mediaProcessor_1.processMedia)(filePath, mimetype);
    }
    catch (error) {
        console.warn('[wa][send][media][process][warn]', error);
        throw new Error('media_processing_failed');
    }
    const buffer = fs_1.default.readFileSync(filePath);
    const mime = mediaInfo.mimetype;
    let message = { caption: options.caption };
    if (mime.startsWith('image/'))
        message.image = buffer;
    else if (mime.startsWith('video/'))
        message.video = buffer;
    else if (mime.startsWith('audio/'))
        message.audio = buffer;
    else if (mime === 'image/webp')
        message.sticker = buffer;
    else
        message.document = buffer, message.mimetype = mime, message.fileName = path_1.default.basename(filePath);
    const result = await s.sock.sendMessage(jid, message);
    // Armazenar informações da mídia enviada
    if (result) {
        const msgId = result.key?.id;
        if (msgId) {
            const msgObj = {
                id: msgId,
                from: s.sock.user?.id || sessionId,
                to: jid,
                text: options.caption || `📎 ${mediaInfo.filename}`,
                fromMe: true,
                timestamp: Date.now(),
                mediaType: mediaInfo.type,
                mediaPath: mediaInfo.originalPath,
                thumbnailPath: mediaInfo.thumbnailPath,
                previewPath: mediaInfo.previewPath,
                mediaInfo: {
                    type: mediaInfo.type,
                    mimetype: mediaInfo.mimetype,
                    size: mediaInfo.size,
                    width: mediaInfo.width,
                    height: mediaInfo.height,
                    duration: mediaInfo.duration,
                    filename: mediaInfo.filename
                }
            };
            // Salvar no store local
            (0, messageStore_1.appendMessage)(sessionId, msgObj);
            // Broadcast para clientes conectados
            try {
                (0, realtime_1.broadcast)(sessionId, 'message', msgObj);
            }
            catch (e) {
                console.warn('[wa][send][broadcast][warn]', e);
            }
        }
    }
    return result;
}
// Novo: estado resumido da sessão
function getStatus(sessionId) {
    // tenta global.sessoes se existir, depois fallback local
    const globalSessions = global.sessions;
    const s = globalSessions?.get?.(sessionId) ?? sessions.get(sessionId);
    const jid = s?.sock?.user?.id || null;
    return { state: s?.lastState ?? 'unknown', hasQR: !!s?.qrDataUrl, jid };
}
function getDebug(sessionId) {
    const s = sessions.get(sessionId);
    if (!s)
        return { exists: false };
    const maxQrEnv = Number(process.env.QR_MAX_BEFORE_RESET || 8);
    const maxMsEnv = Number(process.env.QR_MAX_AGE_BEFORE_RESET || 120000);
    const autoResetEnabled = maxQrEnv > 0 && maxMsEnv > 0;
    const scanGraceRemaining = s.scanGraceUntil ? Math.max(0, s.scanGraceUntil - Date.now()) : null;
    return {
        exists: true,
        state: s.lastState,
        hasQR: !!s.qrDataUrl,
        lastQRAt: s.lastQRAt,
        msSinceLastQR: s.lastQRAt ? Date.now() - s.lastQRAt : null,
        firstQRAt: s.firstQRAt || null,
        msSinceFirstQR: s.firstQRAt ? Date.now() - s.firstQRAt : null,
        qrGenCount: s.qrGenCount || 0,
        starting: !!s.starting,
        startingSince: s.startingSince,
        msStarting: s.startingSince ? Date.now() - s.startingSince : null,
        lastDisconnectCode: s.lastDisconnectCode,
        restartCount: s.restartCount || 0,
        criticalCount: s.criticalCount || 0,
        nextRetryAt: s.nextRetryAt || null,
        msUntilRetry: s.nextRetryAt ? Math.max(0, s.nextRetryAt - Date.now()) : null,
        lastOpenAt: s.lastOpenAt || null,
        autoResetEnabled,
        qrMaxBeforeReset: maxQrEnv,
        qrMaxAgeMsBeforeReset: maxMsEnv,
        manualMode: !!s.manualMode,
        scanGraceUntil: s.scanGraceUntil || null,
        scanGraceRemaining,
    };
}
// Expor mensagens recentes (em memória)
// (mantido por compat interna) mensagens antigas em memória curta
function getMessagesLegacy(sessionId, limit = 100) {
    const s = sessions.get(sessionId);
    if (!s?.messages)
        return [];
    return s.messages.slice(-limit);
}
// List meta for all sessions (for metrics)
function getAllSessionMeta() {
    const out = {};
    for (const [id, s] of sessions.entries()) {
        out[id] = {
            state: s.lastState || 'unknown',
            restartCount: s.restartCount || 0,
            criticalCount: s.criticalCount || 0,
            lastDisconnectCode: s.lastDisconnectCode || null,
            lastOpenAt: s.lastOpenAt || null,
            hasQR: !!s.qrDataUrl,
            messagesInMemory: s.messages?.length || 0
        };
    }
    return out;
}
// Efetua logout (se possível) e remove credenciais para forçar novo pareamento limpo
async function cleanLogout(sessionId, { keepMessages = false } = {}) {
    const sess = sessions.get(sessionId);
    const baseDir = sess?.baseDir || path_1.default.join(SESS_DIR, sessionId);
    // Tentar logout/fechar socket caso exista
    try {
        if (sess?.sock) {
            try {
                await sess.sock.logout?.();
            }
            catch { }
            try {
                sess.sock.ws.close();
            }
            catch { }
        }
    }
    catch { }
    // Remover diretório de credenciais (mesmo se sessão não está em memória)
    try {
        nukeDir(baseDir);
    }
    catch { }
    // Preservar mensagens em memória opcionalmente
    const preservedMsgs = keepMessages ? (sess?.messages ? [...sess.messages] : []) : undefined;
    sessions.delete(sessionId);
    if (keepMessages) {
        // Recria placeholder da sessão somente com mensagens preservadas (sem sock)
        sessions.set(sessionId, { baseDir, messages: preservedMsgs || [] });
    }
    // Opcional: refletir no banco status "closed"
    try {
        await db_1.supa.from('sessions').upsert({ session_id: sessionId, status: 'closed' }, { onConflict: 'session_id' });
    }
    catch { }
    return { ok: true, cleaned: true };
}
// Remove TODAS as sessões (memória + diretórios). Uso cuidadoso.
function nukeAllSessions() {
    for (const [id, s] of Array.from(sessions.entries())) {
        try {
            s.sock?.logout?.();
        }
        catch { }
        try {
            s.sock?.ws.close();
        }
        catch { }
        try {
            nukeDir(s.baseDir);
        }
        catch { }
        sessions.delete(id);
    }
    return { ok: true };
}
// ==== Novos helpers públicos solicitados ====
function getSessionStatus(sessionId) {
    const s = sessions.get(sessionId);
    const jid = s?.sock?.user?.id || null;
    return { state: sessionState.get(sessionId) || 'closed', jid };
}
function getMessages(sessionId, limit = 500) {
    const all = sessionMsgs.get(sessionId) || [];
    const n = Math.max(1, Math.min(5000, Number(limit) || 500));
    return all.slice(-n);
}
function onMessageStream(sessionId, cb) {
    const b = busFor(sessionId);
    const fn = (m) => cb(m);
    b.on('message', fn);
    return () => b.off('message', fn);
}
