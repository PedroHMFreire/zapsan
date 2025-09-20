"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureDir = ensureDir;
exports.jsonError = jsonError;
exports.resolveSessionPath = resolveSessionPath;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function ensureDir(dir) {
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
}
function jsonError(error, message) {
    return { error, ...(message ? { message } : {}) };
}
function resolveSessionPath(sessionId) {
    return path_1.default.join(process.cwd(), 'sessions', sessionId);
}
