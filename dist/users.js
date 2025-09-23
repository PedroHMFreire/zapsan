"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUser = createUser;
exports.verifyLogin = verifyLogin;
exports.getUser = getUser;
exports.listUsers = listUsers;
exports.updateUser = updateUser;
exports.deleteUser = deleteUser;
exports.findUser = findUser;
exports.upsertUserIfMissing = upsertUserIfMissing;
exports.authenticate = authenticate;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("./db");
// === Hash helpers (scrypt) ===
function hash(password) {
    const salt = crypto_1.default.randomBytes(16);
    const N = 16384, r = 8, p = 1, keylen = 64;
    return new Promise((resolve, reject) => {
        crypto_1.default.scrypt(password, salt, keylen, { N, r, p }, (err, derived) => {
            if (err)
                return reject(err);
            resolve(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`);
        });
    });
}
function verify(password, stored) {
    if (!stored)
        return Promise.resolve(false);
    try {
        const [algo, Ns, rs, ps, saltB64, hashB64] = stored.split('$');
        if (algo !== 'scrypt')
            return Promise.resolve(false);
        const N = Number(Ns), r = Number(rs), p = Number(ps);
        const salt = Buffer.from(saltB64, 'base64');
        const expected = Buffer.from(hashB64, 'base64');
        return new Promise((resolve) => {
            crypto_1.default.scrypt(password, salt, expected.length, { N, r, p }, (err, derived) => {
                if (err)
                    return resolve(false);
                try {
                    resolve(crypto_1.default.timingSafeEqual(expected, derived));
                }
                catch {
                    resolve(false);
                }
            });
        });
    }
    catch {
        return Promise.resolve(false);
    }
}
// === Mapeadores ===
function toPublic(u) { return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt }; }
// === Funções baseadas em email ===
async function createUser({ email, name, password }) {
    const emailLc = email.trim().toLowerCase();
    const passwordHash = await hash(password);
    const { data, error } = await db_1.supa.from('users').insert({ email: emailLc, name: name || null, passwordHash }).select('*').single();
    if (error) {
        const msg = error.message || '';
        if (/duplicate|unique|23505/i.test(msg))
            throw new Error('user_exists');
        throw new Error(msg || 'create_failed');
    }
    return toPublic(data);
}
async function verifyLogin({ email, password }) {
    const emailLc = email.trim().toLowerCase();
    const { data: u } = await db_1.supa.from('users').select('id, email, name, passwordHash, createdAt').eq('email', emailLc).single();
    if (!u)
        return { ok: false };
    const ok = await verify(password, u.passwordHash);
    if (!ok)
        return { ok: false };
    return { ok: true, user: toPublic(u) };
}
async function getUser(idOrEmail) {
    let where;
    if (/^[0-9a-fA-F-]{36}$/.test(idOrEmail) || idOrEmail.startsWith('u_')) { // uuid
        where = { id: idOrEmail };
    }
    else {
        where = { email: idOrEmail.toLowerCase() };
    }
    let query = db_1.supa.from('users').select('id, email, name, createdAt');
    if (where.id) {
        query = query.eq('id', where.id);
    }
    if (where.email) {
        query = query.eq('email', where.email);
    }
    const { data: u } = await query.single();
    if (!u)
        return null;
    return toPublic(u);
}
async function listUsers() {
    const { data, error } = await db_1.supa.from('users').select('id, email, name, createdAt').order('createdAt', { ascending: false });
    if (error)
        return [];
    return (data || []).map(toPublic);
}
async function updateUser(id, patch) {
    const { data: existing } = await db_1.supa.from('users').select('id').eq('id', id).single();
    if (!existing)
        throw new Error('user_not_found');
    const data = {};
    if (typeof patch.name === 'string')
        data.name = patch.name;
    if (typeof patch.email === 'string')
        data.email = patch.email.toLowerCase();
    if (typeof patch.password === 'string' && patch.password) {
        data.passwordHash = await hash(patch.password);
    }
    const { data: updated, error } = await db_1.supa.from('users').update(data).eq('id', id).select('id, email, name, createdAt').single();
    if (error || !updated)
        throw new Error('update_failed');
    return toPublic(updated);
}
async function deleteUser(id) {
    const { error } = await db_1.supa.from('users').delete().eq('id', id);
    if (error) {
        if (/not.*found/i.test(error.message || ''))
            throw new Error('user_not_found');
        // Supabase delete silent se 0 rows; checar contagem seria outra query (omitimos para simplicidade)
    }
}
// Compatibilidade com rotas antigas (mantidas assinaturas auxiliares)
async function findUser(email) {
    const emailLc = email.toLowerCase();
    const { data } = await db_1.supa.from('users').select('*').eq('email', emailLc).single();
    return data || null;
}
async function upsertUserIfMissing(name, email, password) {
    const emailLc = email.toLowerCase();
    const { data: u } = await db_1.supa.from('users').select('*').eq('email', emailLc).single();
    if (u)
        return u;
    const created = await createUser({ email: emailLc, name, password });
    return { id: created.id, email: created.email, name: created.name, createdAt: created.createdAt };
}
async function authenticate(email, password) {
    const { ok, user } = await verifyLogin({ email, password });
    if (!ok || !user)
        return null;
    return { id: user.id, email: user.email, name: user.name };
}
