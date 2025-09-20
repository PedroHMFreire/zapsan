// src/wa.ts
// Mantém a API ORIGINAL: createOrLoadSession, getQR, sendText
// Corrige 515/401 (reset de sessão), usa fetchLatestBaileysVersion e persistência em Volume.

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  WASocket,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import QRCode from 'qrcode'

const SESS_DIR = process.env.SESS_DIR || '/data/baileys-auth'

type Sess = {
  sock?: WASocket
  baseDir: string
  qr?: string | null
  starting?: boolean
}

const sessions = new Map<string, Sess>()

function ensureDir(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
}
function nukeDir(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// API ORIGINAL: dispara boot (não bloqueante) e mantém sessão viva
export async function createOrLoadSession(sessionId: string): Promise<void> {
  if (!sessionId) throw new Error('session_id_required')

  // evita boot concorrente
  const existing = sessions.get(sessionId)
  if (existing?.sock || existing?.starting) return

  const baseDir = path.join(SESS_DIR, sessionId)
  ensureDir(baseDir)
  sessions.set(sessionId, { baseDir, starting: true, qr: null })

  const boot = async () => {
    const sess = sessions.get(sessionId)!
    const { state, saveCreds } = await useMultiFileAuthState(baseDir)
    const { version } = await fetchLatestBaileysVersion() // evita incompatibilidade → 515

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

    sess.sock = sock
    sess.starting = false
    sess.qr = null

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
      const code =
        (u.lastDisconnect?.error as any)?.output?.statusCode ||
        (u.lastDisconnect?.error as any)?.status ||
        0

      if (u.qr) {
        try {
          sess.qr = await QRCode.toDataURL(u.qr, { margin: 0 })
        } catch {
          sess.qr = null
        }
      }

      if (u.connection === 'open') {
        sess.qr = null
      }

      if (u.connection === 'close') {
        const isStreamError =
          code === 515 || (u.lastDisconnect?.error as any)?.message?.includes('Stream Errored')
        const isLoggedOut =
          (u.lastDisconnect?.error as any)?.output?.statusCode === DisconnectReason.loggedOut ||
          code === 401

        // >>> correção: 515/401 resetam credenciais e refazem pareamento
        if (isStreamError || isLoggedOut) {
          nukeDir(baseDir)
          sessions.set(sessionId, { baseDir, starting: false, qr: null })
          setTimeout(() => createOrLoadSession(sessionId).catch(() => {}), 1500)
          return
        }

        // demais causas → tenta reconectar preservando auth
        sessions.set(sessionId, { baseDir, starting: false, qr: sess.qr || null })
        setTimeout(() => createOrLoadSession(sessionId).catch(() => {}), 1500)
      }
    })
  }

  boot().catch(() => {
    sessions.set(sessionId, { baseDir, starting: false, qr: null })
  })
}

// API ORIGINAL: retorna QR (dataURL) se ainda não logado
export function getQR(sessionId: string): string | null {
  const s = sessions.get(sessionId)
  return s?.qr || null
}

// API ORIGINAL: envia texto
export async function sendText(sessionId: string, to: string, text: string) {
  if (!sessionId) throw new Error('session_id_required')
  const s = sessions.get(sessionId)
  if (!s?.sock) throw new Error('session_not_found')

  const jid = to.includes('@s.whatsapp.net') || to.includes('@g.us')
    ? to
    : `${to.replace(/\D/g, '')}@s.whatsapp.net`

  await s.sock.sendMessage(jid, { text })
}
