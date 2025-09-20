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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrLoadSession = createOrLoadSession;
exports.getQR = getQR;
exports.sendText = sendText;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const qrcode_1 = __importDefault(require("qrcode"));
const logger_1 = require("./logger");
const utils_1 = require("./utils");
const ai_1 = require("./ai");
const sessions = new Map();
async function createOrLoadSession(sessionId) {
    // Reutiliza socket existente
    const existing = sessions.get(sessionId)?.sock;
    if (existing)
        return existing;
    const dir = (0, utils_1.resolveSessionPath)(sessionId);
    (0, utils_1.ensureDir)(dir);
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(dir);
    const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
    const shouldSyncHistoryMessage = false;
    const sock = (0, baileys_1.default)({
        auth: state,
        version, // evita problemas de protocolo
        printQRInTerminal: false,
        browser: ['ZapSan', 'Chrome', '1.0.0'],
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
        // @ts-expect-error flag suportada em versões recentes; evita sync pesado inicial
        shouldSyncHistoryMessage,
    });
    sessions.set(sessionId, { sock, qrDataUrl: null, lastState: 'connecting', retries: 0 });
    // Salvar credenciais SEMPRE
    sock.ev.on('creds.update', saveCreds);
    // Estado de conexão + QR
    sock.ev.on('connection.update', async (update) => {
        const sref = sessions.get(sessionId);
        if (!sref)
            return;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        const message = update.lastDisconnect?.error?.message;
        console.debug('DEBUG connection.update:', {
            connection: update.connection,
            isOnline: update?.isOnline,
            receivedPendingNotifications: update?.receivedPendingNotifications,
            code,
            message,
        });
        if (update.qr) {
            try {
                sref.qrDataUrl = await qrcode_1.default.toDataURL(update.qr);
                logger_1.logger.info({ sessionId }, 'QR atualizado');
                // (opcional) ASCII no terminal se qrcode-terminal estiver instalado
                try {
                    // @ts-ignore - import dinâmico opcional
                    const qrt = await Promise.resolve().then(() => __importStar(require('qrcode-terminal')));
                    qrt.default?.generate
                        ? qrt.default.generate(update.qr, { small: true })
                        : qrt.generate(update.qr, { small: true });
                }
                catch { }
            }
            catch (err) {
                logger_1.logger.error({ err }, 'Falha ao gerar dataURL do QR');
            }
        }
        if (update.connection) {
            sref.lastState = update.connection;
            logger_1.logger.info({ sessionId, connection: update.connection }, 'connection.update');
        }
        if (update.connection === 'open') {
            sref.qrDataUrl = null; // limpamos o QR quando abriu
            sref.retries = 0;
            logger_1.logger.info({ sessionId }, 'Conexão aberta (QR limpo)');
        }
        if (update.connection === 'close') {
            logger_1.logger.warn({ sessionId, code, message }, 'Conexão fechada');
            const retriable = [408, 410, 515].includes(code);
            if (code === 401) {
                logger_1.logger.error({ sessionId }, 'Credenciais inválidas/expiradas: apague a pasta sessions/' + sessionId + ' e refaça o pareamento.');
                return;
            }
            if (retriable) {
                const delay = 1500;
                const attempt = (sref.retries = (sref.retries || 0) + 1);
                if (attempt > 8) {
                    logger_1.logger.error({ sessionId, attempt }, 'Limite de tentativas (simples) atingido — parar');
                    return;
                }
                logger_1.logger.info({ sessionId, code, attempt, delay }, 'Retry programado');
                setTimeout(() => createOrLoadSession(sessionId).catch(err => logger_1.logger.error({ err, sessionId }, 'Falha ao reconectar')), delay);
            }
        }
    });
    // Mensagens recebidas -> IA
    sock.ev.on('messages.upsert', async (evt) => {
        const msg = evt.messages?.[0];
        if (!msg || msg.key.fromMe)
            return;
        const from = msg.key.remoteJid || '';
        const text = msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';
        if (!text.trim())
            return;
        try {
            const answer = await (0, ai_1.reply)({ text, from, sessionId });
            await sock.sendMessage(from, { text: answer });
            logger_1.logger.info({ sessionId, from }, 'IA respondeu');
        }
        catch (err) {
            logger_1.logger.error({ err, sessionId }, 'Falha ao responder via IA');
        }
    });
    return sock;
}
function getQR(sessionId) {
    const s = sessions.get(sessionId);
    return s?.qrDataUrl || null;
}
async function sendText(sessionId, to, text) {
    const s = sessions.get(sessionId);
    if (!s?.sock)
        throw new Error('session_not_found');
    await s.sock.sendMessage(to, { text });
}
// Handlers globais (captura erros silenciosos)
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION', e));
process.on('uncaughtException', (e) => console.error('UNCAUGHT EXCEPTION', e));
