import { PrismaClient } from '@prisma/client'

// Singleton básico para evitar múltiplas conexões em dev com hot-reload
// (Node 18+ com tsx: manter referência em globalThis durante reloads)
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma || new PrismaClient({
  log: process.env.PRISMA_LOGS ? ['query','error','warn'] : ['error']
})

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = prisma
}

// Opcional: helper de graceful shutdown (pode ser usado em server.ts futuramente)
export async function disconnectPrisma(){
  try { await prisma.$disconnect() } catch {}
}
