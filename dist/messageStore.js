"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendMessage = appendMessage;
exports.updateMessageStatus = updateMessageStatus;
exports.queryMessages = queryMessages;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DATA_DIR = path_1.default.join(process.cwd(), 'data');
const MSG_DIR = path_1.default.join(DATA_DIR, 'messages');
function ensureDirs() {
    try {
        fs_1.default.mkdirSync(MSG_DIR, { recursive: true });
    }
    catch { }
}
ensureDirs();
// Debounce controlar múltiplas escritas próximas
const pendingWrites = new Map();
const caches = new Map();
function filePath(sessionId) {
    return path_1.default.join(MSG_DIR, `${sessionId}.json`);
}
function load(sessionId) {
    const cached = caches.get(sessionId);
    if (cached)
        return cached;
    let idx = { messages: [] };
    try {
        const raw = fs_1.default.readFileSync(filePath(sessionId), 'utf8');
        idx = JSON.parse(raw);
    }
    catch { }
    caches.set(sessionId, idx);
    return idx;
}
function scheduleSave(sessionId) {
    if (pendingWrites.has(sessionId))
        return;
    const t = setTimeout(() => {
        pendingWrites.delete(sessionId);
        const idx = caches.get(sessionId);
        if (!idx)
            return;
        try {
            fs_1.default.writeFileSync(filePath(sessionId), JSON.stringify(idx, null, 2), 'utf8');
        }
        catch { }
    }, 1000); // 1s debounce
    pendingWrites.set(sessionId, t);
}
function appendMessage(sessionId, msg) {
    const idx = load(sessionId);
    idx.messages.push(msg);
    // proteção de tamanho
    if (idx.messages.length > 5000) {
        idx.messages.splice(0, idx.messages.length - 5000);
    }
    scheduleSave(sessionId);
}
function updateMessageStatus(sessionId, id, status) {
    const idx = load(sessionId);
    const m = idx.messages.find(m => m.id === id);
    if (m) {
        m.status = status;
        scheduleSave(sessionId);
    }
}
function queryMessages(sessionId, opts) {
    const idx = load(sessionId);
    let list = idx.messages;
    if (opts.after)
        list = list.filter(m => m.timestamp > opts.after);
    if (opts.before)
        list = list.filter(m => m.timestamp < opts.before);
    if (opts.from)
        list = list.filter(m => m.from === opts.from || m.to === opts.from);
    if (opts.direction === 'in')
        list = list.filter(m => !m.fromMe);
    if (opts.direction === 'out')
        list = list.filter(m => m.fromMe);
    if (opts.search) {
        const q = opts.search.toLowerCase();
        list = list.filter(m => m.text.toLowerCase().includes(q));
    }
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
    return list.slice(-limit);
}
