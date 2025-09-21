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
exports.createOrLoadSession = createOrLoadSession;
exports.getQR = getQR;
exports.sendText = sendText;
exports.getStatus = getStatus;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const qrcode_1 = __importDefault(require("qrcode"));
// Mantém comportamento antigo: pasta local "sessions".
// Se quiser, pode definir SESS_DIR no Render sem quebrar local.
const SESS_DIR = process.env.SESS_DIR || path_1.default.resolve(process.cwd(), 'sessions');
const sessions = new Map();
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
    sessions.set(sessionId, { baseDir, starting: true, qr: null });
    const boot = async () => {
        const sess = sessions.get(sessionId);
        const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(baseDir);
        // >>> Correção 1: usar sempre a versão correta do WhatsApp Web
        const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
        const sock = (0, baileys_1.default)({
            version,
            auth: state,
            printQRInTerminal: false, // seu front já consome o QR
            browser: ['Ubuntu', 'Chrome', '121'],
            keepAliveIntervalMs: 30000,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            logger: (0, pino_1.default)({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' }),
        });
        sess.sock = sock;
        sess.starting = false;
        sess.qr = null;
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (u) => {
            if (u.connection) {
                sess.lastState = u.connection;
            }
            // transforma QR em dataURL para o endpoint /sessions/:id/qr
            if (u.qr) {
                try {
                    const dataUrl = await qrcode_1.default.toDataURL(u.qr, { margin: 0 });
                    sess.qr = dataUrl; // retrocompat
                    sess.qrDataUrl = dataUrl;
                }
                catch {
                    sess.qr = null;
                    sess.qrDataUrl = null;
                }
            }
            if (u.connection === 'open') {
                sess.qr = null;
                sess.qrDataUrl = null;
            }
            if (u.connection === 'close') {
                const code = u.lastDisconnect?.error?.output?.statusCode ||
                    u.lastDisconnect?.error?.status || 0;
                const isStreamErrored = code === 515 || u.lastDisconnect?.error?.message?.includes('Stream Errored');
                const isLoggedOut = code === 401 ||
                    u.lastDisconnect?.error?.output?.statusCode === baileys_1.DisconnectReason.loggedOut;
                // >>> Correção 2: em 515/401, resetar credenciais e re-parear
                if (isStreamErrored || isLoggedOut) {
                    nukeDir(baseDir); // limpa a sessão corrompida
                    sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: 'restarting', qrDataUrl: null });
                    setTimeout(() => createOrLoadSession(sessionId).catch(() => { }), 1500);
                    return;
                }
                // outros motivos (timeout, rede etc) → tenta reconectar preservando auth
                sessions.set(sessionId, { baseDir, starting: false, qr: sess.qr || null, lastState: 'reconnecting', qrDataUrl: sess.qrDataUrl || null });
                setTimeout(() => createOrLoadSession(sessionId).catch(() => { }), 1500);
            }
        });
    };
    boot().catch(() => {
        sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: 'error_init', qrDataUrl: null });
    });
}
// === API ORIGINAL ===
function getQR(sessionId) {
    const s = sessions.get(sessionId);
    return s?.qr || null;
}
// === API ORIGINAL ===
async function sendText(sessionId, to, text) {
    const s = sessions.get(sessionId);
    if (!s?.sock)
        throw new Error('session_not_found');
    const jid = to.includes('@s.whatsapp.net') || to.includes('@g.us')
        ? to
        : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
    await s.sock.sendMessage(jid, { text });
}
// Novo: estado resumido da sessão
function getStatus(sessionId) {
    // tenta global.sessoes se existir, depois fallback local
    const globalSessions = global.sessions;
    const s = globalSessions?.get?.(sessionId) ?? sessions.get(sessionId);
    return { state: s?.lastState ?? 'unknown', hasQR: !!s?.qrDataUrl };
}
