// Mantém a API ORIGINAL do seu projeto:
//   createOrLoadSession(sessionId)
//   getQR(sessionId)
//   sendText(sessionId, to, text)
// Corrige especificamente: erro 515/401 com reset de sessão + usa versão mais recente do WA.

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

// Mantém comportamento antigo: pasta local "sessions".
// Se quiser, pode definir SESS_DIR no Render sem quebrar local.
const SESS_DIR = process.env.SESS_DIR || path.resolve(process.cwd(), 'sessions')

type Sess = {
  sock?: WASocket
  baseDir: string
  qr?: string | null
  starting?: boolean
  lastState?: string
  qrDataUrl?: string | null
}

const sessions = new Map<string, Sess>()
// expõe no global opcionalmente (usado por getStatus se disponível)
;(global as any).sessions = (global as any).sessions || sessions

const ensureDir = (dir: string) => {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
}
const nukeDir = (dir: string) => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// === API ORIGINAL ===
// Dispara/recupera a sessão; não muda a assinatura original
export async function createOrLoadSession(sessionId: string): Promise<void> {
  if (!sessionId) throw new Error('session_id_required')

  const current = sessions.get(sessionId)
  if (current?.sock || current?.starting) return

  const baseDir = path.join(SESS_DIR, sessionId)
  ensureDir(baseDir)
  sessions.set(sessionId, { baseDir, starting: true, qr: null })

  const boot = async () => {
    const sess = sessions.get(sessionId)!
    const { state, saveCreds } = await useMultiFileAuthState(baseDir)

    // >>> Correção 1: usar sempre a versão correta do WhatsApp Web
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,        // seu front já consome o QR
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
      if (u.connection) {
        sess.lastState = u.connection
      }
      // transforma QR em dataURL para o endpoint /sessions/:id/qr
      if (u.qr) {
        try {
          const dataUrl = await QRCode.toDataURL(u.qr, { margin: 0 })
          sess.qr = dataUrl // retrocompat
          sess.qrDataUrl = dataUrl
        } catch {
          sess.qr = null
          sess.qrDataUrl = null
        }
      }
      if (u.connection === 'open') {
        sess.qr = null
        sess.qrDataUrl = null
      }

      if (u.connection === 'close') {
        const code =
          (u.lastDisconnect?.error as any)?.output?.statusCode ||
          (u.lastDisconnect?.error as any)?.status || 0

        const isStreamErrored =
          code === 515 || (u.lastDisconnect?.error as any)?.message?.includes('Stream Errored')

        const isLoggedOut =
          code === 401 ||
          (u.lastDisconnect?.error as any)?.output?.statusCode === DisconnectReason.loggedOut

        // >>> Correção 2: em 515/401, resetar credenciais e re-parear
        if (isStreamErrored || isLoggedOut) {
          nukeDir(baseDir) // limpa a sessão corrompida
          sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: 'restarting', qrDataUrl: null })
          setTimeout(() => createOrLoadSession(sessionId).catch(() => {}), 1500)
          return
        }

        // outros motivos (timeout, rede etc) → tenta reconectar preservando auth
        sessions.set(sessionId, { baseDir, starting: false, qr: sess.qr || null, lastState: 'reconnecting', qrDataUrl: sess.qrDataUrl || null })
        setTimeout(() => createOrLoadSession(sessionId).catch(() => {}), 1500)
      }
    })
  }

  boot().catch(() => {
    sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: 'error_init', qrDataUrl: null })
  })
}

// === API ORIGINAL ===
export function getQR(sessionId: string): string | null {
  const s = sessions.get(sessionId)
  return s?.qr || null
}

// === API ORIGINAL ===
export async function sendText(sessionId: string, to: string, text: string) {
  const s = sessions.get(sessionId)
  if (!s?.sock) throw new Error('session_not_found')

  const jid = to.includes('@s.whatsapp.net') || to.includes('@g.us')
    ? to
    : `${to.replace(/\D/g, '')}@s.whatsapp.net`

  await s.sock.sendMessage(jid, { text })
}

// Novo: estado resumido da sessão
export function getStatus(sessionId: string) {
  // tenta global.sessoes se existir, depois fallback local
  const globalSessions: any = (global as any).sessions
  const s: Sess | undefined = globalSessions?.get?.(sessionId) ?? sessions.get(sessionId)
  return { state: s?.lastState ?? 'unknown', hasQR: !!s?.qrDataUrl }
}
