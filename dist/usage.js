"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PLAN = void 0;
exports.getPlan = getPlan;
exports.recordMessage = recordMessage;
exports.getUsage = getUsage;
exports.checkQuota = checkQuota;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DATA_FILE = path_1.default.join(process.cwd(), 'data', 'usage.json');
let store = {};
function load() { try {
    store = JSON.parse(fs_1.default.readFileSync(DATA_FILE, 'utf8'));
}
catch {
    store = {};
} }
function save() { try {
    fs_1.default.mkdirSync(path_1.default.dirname(DATA_FILE), { recursive: true });
    fs_1.default.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}
catch { } }
load();
exports.DEFAULT_PLAN = { name: 'Free', quotaDaily: 500, expiresAt: null };
function getPlan(_userId) {
    // Futuro: carregar de arquivo/DB; hoje sempre default
    return exports.DEFAULT_PLAN;
}
function roll(entry) {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (entry.date !== todayStr) {
        entry.date = todayStr;
        entry.today = 0;
    }
    return entry;
}
function getEntry(sessionId) {
    let e = store[sessionId];
    if (!e) {
        e = { total: 0, today: 0, date: new Date().toISOString().slice(0, 10) };
        store[sessionId] = e;
    }
    return roll(e);
}
function recordMessage(sessionId) {
    const e = getEntry(sessionId);
    e.today += 1;
    e.total += 1;
    save();
    return { today: e.today, total: e.total };
}
function getUsage(sessionId) {
    const e = getEntry(sessionId);
    return { messagesToday: e.today, total: e.total };
}
function checkQuota(userId, sessionId) {
    const plan = getPlan(userId);
    const { messagesToday } = getUsage(sessionId);
    const remaining = plan.quotaDaily - messagesToday;
    if (remaining <= 0) {
        return { ok: false, remaining: 0, plan };
    }
    return { ok: true, remaining, plan };
}
