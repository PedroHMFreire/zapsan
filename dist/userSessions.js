"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrCreateUserSession = getOrCreateUserSession;
exports.getUserSession = getUserSession;
exports.setUserSession = setUserSession;
exports.ensureSessionStarted = ensureSessionStarted;
exports.listUserSessions = listUserSessions;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("./db");
const wa_1 = require("./wa");
// Retorna a sessionId mais recente ou cria uma nova vinculada ao userId
async function getOrCreateUserSession(userId) {
    if (!userId)
        throw new Error('missing_user');
    const existing = await db_1.prisma.session.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    if (existing)
        return existing.sessionId;
    const sessionId = 'u_' + crypto_1.default.randomUUID();
    await db_1.prisma.session.create({ data: { sessionId, status: 'connecting', userId } });
    return sessionId;
}
async function getUserSession(userId) {
    if (!userId)
        return null;
    const existing = await db_1.prisma.session.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return existing?.sessionId || null;
}
async function setUserSession(userId, sessionId) {
    if (!userId || !sessionId)
        throw new Error('missing_params');
    await db_1.prisma.session.upsert({
        where: { sessionId },
        update: { userId },
        create: { sessionId, status: 'connecting', userId }
    });
}
async function ensureSessionStarted(userId) {
    const sessionId = await getOrCreateUserSession(userId);
    (0, wa_1.createOrLoadSession)(sessionId).catch(() => { });
    return { sessionId };
}
// (Opcional) manter função de listagem antiga para debug, agora vinda do banco
async function listUserSessions() {
    const sessions = await db_1.prisma.session.findMany({ select: { sessionId: true, userId: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    const map = {};
    sessions.forEach((s) => { if (s.userId && !(s.userId in map))
        map[s.userId] = s.sessionId; });
    return map;
}
