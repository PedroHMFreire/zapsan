// src/wa.ts
// Baileys bootstrap completo e robusto para Render/K8s.
//
// REQUISITOS:
// - Adicione a lib: npm i @whiskeysockets/baileys pino qrcode
// - Monte um Volume no Render e mapeie para /data
// - (Opcional) defina SESS_DIR=/data/baileys-auth
//
// COMO USAR (exemplo nas suas rotas):
//   import { startSession, getSessionState, getSessionQR, sendText, destroySession } from './wa'
//   app.post('/api/sessions/create', async (req,res)=>{ await startSession(req.body.sessionId); res.json({ok:true}) })
//   app.get('/api/sessions/:id/qr', async (req,res)=>{ res.json(await getSessionQR(req.params.id)) })
//   app.get('/healthz/:id', (req,res)=>{ res.json(getSessionState(req.params.id)) })
//   app.post('/api/sessions/:id/send', async (req,res)=>{ await sendText(req.params.id, req.body.jid, req.body.text); res.json({ok:true}) })
//   app.delete('/api/sessions/:id', async (req,res)=>{ await destroySession(req.params.id); res.json({ok:true}) })

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  WASocket,
  proto,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import QRCode from 'qrcode'

const SESS_DIR = process.env.SESS_DIR || '/data/baileys-auth'

// -----------------------
// Tipos e estados
// -----------------------
type Status = 'offline' | 'connecting' | 'qr' | 'online'

export type SessionState = {
  sessionId: string
  status: Status
  qr?: string | null       // dataURL
  lastCode?: number | null // último código de desconexão
  isStarting?: boolean
}

type SessionRecord = {
  sock?: WASocket
  state: SessionState
  baseDir: string
}

const sessions = new Map<string, SessionRecord>()

// -----------------------
// Helpers de arquivo
// -----------------------
function ensureDir(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
}
function nukeDir(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// -----------------------
// Core: criar/iniciar sessão
// -----------------------
export async function startSession(sessionId = 'default'): Promise<WASocket> {
  let rec = sessions.get(sessionId)
  if (rec?.sock) {
    // Já existe uma instância ativa
    return rec.sock
  }

  const baseDir = path.join(SESS_DIR, sessionId)
  ensureDir(baseDir)

  // Evita boot concorrente
  if (!rec) {
    rec = {
      baseDir,
      state: {
        sessionId,
        status: 'connecting',
        qr: null,
        lastCode: null,
        isStarting: true,
      },
    }
    sessions.set(sessionId, rec)
  } else {
    rec.state.status = 'connecting'
    rec.state.isStarting = true
    rec.state.qr = null
    rec.state.lastCode = null
  }

  // Carrega estado multi-arquivo
  const { state, saveCreds } = await useMultiFileAuthState(baseDir)

  // Sempre usa a versão mais recente do WhatsApp Web
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '121'],
    keepAliveIntervalMs: 30_000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger: pino({ level: (process.env.BAILEYS_LOG_LEVEL as pino.Level) || 'warn' }),
  })

  rec.sock = sock
  rec.state.status = 'connecting'
  rec.state.isStarting = false

  // Persistência de credenciais
  sock.ev.on('creds.update', saveCreds)

  // QR e conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update
    const code =
      (lastDisconnect?.error as any)?.output?.statusCode ||
      (lastDisconnect?.error as any)?.status ||
      0
    rec!.state.lastCode = code || null

    // QR como DataURL para exibição no front
    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 0 })
        rec!.state.qr = dataUrl
        rec!.state.status = 'qr'
      } catch {
        rec!.state.qr = null
        rec!.state.status = 'qr'
      }
    }

    if (connection === 'open') {
      rec!.state.status = 'online'
      rec!.state.qr = null
    }

    if (connection === 'close') {
      // Detecta "stream errored" (515) ou auth inválida (401)
      const isStreamError =
        code === 515 ||
        (lastDisconnect?.error as any)?.message?.includes('Stream Errored')

      const shouldReset =
        isStreamError ||
        (lastDisconnect?.error as any)?.output?.statusCode === DisconnectReason.loggedOut ||
        code === 401

      if (shouldReset) {
        // Sessão inconsistente → apaga credenciais e recomeça com pareamento limpo
        nukeDir(baseDir)
        rec!.state.status = 'offline'
        rec!.state.qr = null
        rec!.sock = undefined
        setTimeout(() => {
          startSession(sessionId).catch(() => {})
        }, 1500)
        return
      }

      // Outros motivos (timeout, network, 408/410, etc) → tenta reconectar preservando auth
      rec!.state.status = 'offline'
      rec!.sock = undefined
      setTimeout(() => {
        startSession(sessionId).catch(() => {})
      }, 1500)
    }
  })

  // Exemplo de recebimento (plugue sua lógica/IA aqui)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!messages?.length) return
    const m = messages[0]
    // Exemplo: auto-ack
    try {
      if (m.key?.remoteJid && m.key.id) {
        await sock.readMessages([m.key])
      }
    } catch {}
    // TODO: chamar seu orquestrador de IA/chatbot aqui
  })

  return sock
}

// -----------------------
// Utilitários expostos
// -----------------------
export function getSessionState(sessionId = 'default'): SessionState {
  const rec = sessions.get(sessionId)
  return (
    rec?.state || {
      sessionId,
      status: 'offline',
      qr: null,
      lastCode: null,
      isStarting: false,
    }
  )
}

export async function getSessionQR(sessionId = 'default'): Promise<{ status: Status; qr: string | null }> {
  const s = getSessionState(sessionId)
  // Garante boot assíncrono, caso não esteja iniciado
  if (s.status === 'offline' && !s.isStarting) {
    await startSession(sessionId).catch(() => {})
  }
  return { status: getSessionState(sessionId).status, qr: getSessionState(sessionId).qr || null }
}

function getSock(sessionId = 'default'): WASocket | undefined {
  return sessions.get(sessionId)?.sock
}

export async function sendText(sessionId: string, jid: string, text: string) {
  const sock = getSock(sessionId) || (await startSession(sessionId))
  // Normaliza JID (se vier só número)
  const normalized = jid.includes('@s.whatsapp.net') || jid.includes('@g.us')
    ? jid
    : `${jid.replace(/\D/g, '')}@s.whatsapp.net`

  await sock.sendMessage(normalized, { text })
}

export async function destroySession(sessionId = 'default') {
  const rec = sessions.get(sessionId)
  try {
    // encerra socket
    await rec?.sock?.logout?.().catch(() => {})
    // apaga credenciais
    nukeDir(rec?.baseDir || path.join(SESS_DIR, sessionId))
  } finally {
    sessions.delete(sessionId)
  }
}

export function isOnline(sessionId = 'default'): boolean {
  return getSessionState(sessionId).status === 'online'
}
