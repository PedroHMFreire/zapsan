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
    const { data: existingList } = await db_1.supa.from('sessions')
        .select('session_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);
    if (existingList && existingList.length) {
        return existingList[0].session_id;
    }
    const sessionId = 'u_' + crypto_1.default.randomUUID();
    await db_1.supa.from('sessions').insert({ session_id: sessionId, status: 'connecting', user_id: userId });
    return sessionId;
}
async function getUserSession(userId) {
    if (!userId)
        return null;
    const { data } = await db_1.supa.from('sessions')
        .select('session_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);
    if (data && data.length) {
        return data[0].session_id;
    }
    return null;
}
async function setUserSession(userId, sessionId) {
    if (!userId || !sessionId)
        throw new Error('missing_params');
    // Upsert manual: tenta atualizar, se não existir insere
    const { error: updErr } = await db_1.supa.from('sessions').update({ user_id: userId }).eq('session_id', sessionId);
    if (updErr) { /* continua tentativa de insert */ }
    // Checar se atualizou alguma (Supabase não retorna contagem sem retornar=representation) -> simplificamos com insert ignorando conflito
    await db_1.supa.from('sessions').upsert({ session_id: sessionId, status: 'connecting', user_id: userId }, { onConflict: 'session_id' });
}
async function ensureSessionStarted(userId) {
    const sessionId = await getOrCreateUserSession(userId);
    (0, wa_1.createOrLoadSession)(sessionId).catch(() => { });
    return { sessionId };
}
// (Opcional) manter função de listagem antiga para debug, agora vinda do banco
async function listUserSessions() {
    const { data } = await db_1.supa.from('sessions').select('session_id, user_id, created_at').order('created_at', { ascending: false });
    const map = {};
    (data || []).forEach((s) => { if (s.user_id && !(s.user_id in map))
        map[s.user_id] = s.session_id; });
    return map;
}
