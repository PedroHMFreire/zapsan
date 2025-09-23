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
function toPublic(u) { return { id: u.id, phone: u.phone, name: u.name, createdAt: u.createdAt }; }
// === Funções exigidas pela nova API (phone baseado) ===
async function createUser({ phone, name, password }) {
    const exists = await db_1.prisma.user.findUnique({ where: { phone } });
    if (exists)
        throw new Error('user_exists');
    const passwordHash = await hash(password);
    const u = await db_1.prisma.user.create({ data: { phone, name, passwordHash } });
    return toPublic(u);
}
async function verifyLogin({ phone, password }) {
    const u = await db_1.prisma.user.findUnique({ where: { phone } });
    if (!u)
        return { ok: false };
    const ok = await verify(password, u.passwordHash);
    if (!ok)
        return { ok: false };
    return { ok: true, user: toPublic(u) };
}
async function getUser(idOrPhone) {
    let where;
    if (/^[0-9a-fA-F-]{36}$/.test(idOrPhone) || idOrPhone.startsWith('u_')) { // uuid simples ou prefixado
        where = { id: idOrPhone };
    }
    else {
        where = { phone: idOrPhone };
    }
    const u = await db_1.prisma.user.findUnique({ where });
    if (!u)
        return null;
    return toPublic(u);
}
async function listUsers() {
    const list = await db_1.prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
    return list.map(toPublic);
}
async function updateUser(id, patch) {
    const existing = await db_1.prisma.user.findUnique({ where: { id } });
    if (!existing)
        throw new Error('user_not_found');
    const data = {};
    if (typeof patch.name === 'string')
        data.name = patch.name;
    if (typeof patch.phone === 'string')
        data.phone = patch.phone;
    if (typeof patch.password === 'string' && patch.password) {
        data.passwordHash = await hash(patch.password);
    }
    const u = await db_1.prisma.user.update({ where: { id }, data });
    return toPublic(u);
}
async function deleteUser(id) {
    try {
        await db_1.prisma.user.delete({ where: { id } });
    }
    catch (err) {
        if (err.code === 'P2025')
            throw new Error('user_not_found');
        throw err;
    }
}
// Compatibilidade com rotas antigas que usam authenticate / upsertUserIfMissing / findUser
// Mantemos assinaturas mas redirecionamos para novas funções (mapeando email->phone)
async function findUser(phone) {
    return db_1.prisma.user.findUnique({ where: { phone } });
}
async function upsertUserIfMissing(name, phone, password) {
    const u = await db_1.prisma.user.findUnique({ where: { phone } });
    if (u)
        return u;
    const created = await createUser({ phone, name, password });
    return { id: created.id, phone: created.phone, name: created.name, createdAt: created.createdAt };
}
async function authenticate(phone, password) {
    const { ok, user } = await verifyLogin({ phone, password });
    if (!ok || !user)
        return null;
    return { id: user.id, phone: user.phone, name: user.name };
}
