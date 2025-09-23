"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
exports.disconnectPrisma = disconnectPrisma;
const client_1 = require("@prisma/client");
// Singleton básico para evitar múltiplas conexões em dev com hot-reload
// (Node 18+ com tsx: manter referência em globalThis durante reloads)
const globalForPrisma = globalThis;
exports.prisma = globalForPrisma.prisma || new client_1.PrismaClient({
    log: process.env.PRISMA_LOGS ? ['query', 'error', 'warn'] : ['error']
});
if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = exports.prisma;
}
// Opcional: helper de graceful shutdown (pode ser usado em server.ts futuramente)
async function disconnectPrisma() {
    try {
        await exports.prisma.$disconnect();
    }
    catch { }
}
