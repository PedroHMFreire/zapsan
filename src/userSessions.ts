import crypto from 'crypto'
import { prisma } from './db'
import { createOrLoadSession } from './wa'

// Retorna a sessionId mais recente ou cria uma nova vinculada ao userId
export async function getOrCreateUserSession(userId: string): Promise<string> {
  if(!userId) throw new Error('missing_user')
  const existing = await prisma.session.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
  if(existing) return existing.sessionId
  const sessionId = 'u_' + crypto.randomUUID()
  await prisma.session.create({ data: { sessionId, status: 'connecting', userId } })
  return sessionId
}

export async function getUserSession(userId: string): Promise<string | null> {
  if(!userId) return null
  const existing = await prisma.session.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
  return existing?.sessionId || null
}

export async function setUserSession(userId: string, sessionId: string): Promise<void> {
  if(!userId || !sessionId) throw new Error('missing_params')
  await prisma.session.upsert({
    where: { sessionId },
    update: { userId },
    create: { sessionId, status: 'connecting', userId }
  })
}

export async function ensureSessionStarted(userId: string): Promise<{ sessionId: string }> {
  const sessionId = await getOrCreateUserSession(userId)
  createOrLoadSession(sessionId).catch(()=>{})
  return { sessionId }
}

// (Opcional) manter função de listagem antiga para debug, agora vinda do banco
export async function listUserSessions(){
  const sessions = await prisma.session.findMany({ select: { sessionId: true, userId: true, createdAt: true }, orderBy: { createdAt: 'desc' } })
  const map: Record<string,string> = {}
  sessions.forEach((s: { sessionId: string; userId: string | null }) => { if(s.userId && !(s.userId in map)) map[s.userId] = s.sessionId })
  return map
}
