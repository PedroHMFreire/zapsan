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
import { proto, downloadMediaMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import QRCode from 'qrcode'
import { appendMessage, updateMessageStatus } from './messageStore'
import { indexMessage } from './searchIndex'
import { broadcast } from './realtime'
import http from 'http'
import https from 'https'

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
  lastQRAt?: number
  startingSince?: number
  lastDisconnectCode?: number
  restartCount?: number
  criticalCount?: number
  nextRetryAt?: number
  messages?: Array<{
    id: string
    from: string
    to?: string
    text: string
    timestamp: number
    fromMe: boolean
    pushName?: string
  }>
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
  sessions.set(sessionId, { baseDir, starting: true, startingSince: Date.now(), qr: null, restartCount: (current?.restartCount||0), criticalCount: current?.criticalCount || 0 })

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
      // Controlado por env: SYNC_FULL_HISTORY=1 para puxar histórico ao conectar
      syncFullHistory: process.env.SYNC_FULL_HISTORY === '1',
      markOnlineOnConnect: false,
      logger: pino({ level: (process.env.BAILEYS_LOG_LEVEL as pino.Level) || 'warn' }),
    })

  sess.sock = sock
    sess.starting = false
    sess.qr = null
    if(!sess.messages) sess.messages = []

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
      // Basic trace
      try { console.log('[wa][update]', sessionId, { connection: u.connection, qr: !!u.qr, lastDisconnect: (u as any)?.lastDisconnect?.error?.message }) } catch {}
      if (u.connection) {
        sess.lastState = u.connection
      }
      // transforma QR em dataURL para o endpoint /sessions/:id/qr
      if (u.qr) {
        try {
          const dataUrl = await QRCode.toDataURL(u.qr, { margin: 0 })
          sess.qr = dataUrl // retrocompat
          sess.qrDataUrl = dataUrl
          sess.lastQRAt = Date.now()
        } catch {
          sess.qr = null
          sess.qrDataUrl = null
        }
      }
      if (u.connection === 'open') {
        // conectado: limpar QR
        sess.qr = null
        sess.qrDataUrl = null
        sess.criticalCount = 0
      }

      if (u.connection === 'close') {
        const code =
          (u.lastDisconnect?.error as any)?.output?.statusCode ||
          (u.lastDisconnect?.error as any)?.status || 0
        sess.lastDisconnectCode = code

        const isStreamErrored =
          code === 515 || (u.lastDisconnect?.error as any)?.message?.includes('Stream Errored')

        const isLoggedOut =
          code === 401 ||
          (u.lastDisconnect?.error as any)?.output?.statusCode === DisconnectReason.loggedOut

        // >>> Correção 2: em 515/401, resetar credenciais e re-parear
        if (isStreamErrored || isLoggedOut) {
          const crit = (sess.criticalCount||0)+1
            sess.criticalCount = crit
          // backoff exponencial simples: 3s * 2^(crit-1), cap 30000ms
          const delay = Math.min(30000, 3000 * Math.pow(2, Math.max(0, crit-1)))
          const shouldNuke = isLoggedOut || crit >= 3 // só apaga após 3 falhas 515 seguidas ou logout
          console.warn('[wa][disconnect-critical]', sessionId, { code, crit, delay, willNuke: shouldNuke })
          if (shouldNuke) {
            nukeDir(baseDir)
          }
          sessions.set(sessionId, { baseDir, starting: false, qr: sess.qr || null, lastState: 'restarting', qrDataUrl: sess.qrDataUrl || null, restartCount: (sess.restartCount||0)+1, criticalCount: sess.criticalCount, nextRetryAt: Date.now()+delay })
          setTimeout(() => createOrLoadSession(sessionId).catch(() => {}), delay)
          return
        }

        // outros motivos (timeout, rede etc) → tenta reconectar preservando auth
        // reconexão leve (rede): manter QR se ainda não conectou / útil para pairing
        const lightDelay = 10000
        sessions.set(sessionId, { baseDir, starting: false, qr: sess.qr || null, lastState: 'reconnecting', qrDataUrl: sess.qrDataUrl || null, restartCount: (sess.restartCount||0)+1, criticalCount: sess.criticalCount||0, nextRetryAt: Date.now()+lightDelay })
        setTimeout(() => createOrLoadSession(sessionId).catch(() => {}), lightDelay)
      }
    })

    // Listener principal de mensagens
    sock.ev.on('messages.upsert', async (m) => {
      const type = m.type // notify, append, replace
      for (const msg of m.messages) {
        if(!msg.message) continue
        const from = msg.key.remoteJid || 'unknown'
        const fromMe = !!msg.key.fromMe
        // Extração de texto simples (apenas casos mais comuns)
        let text = ''
        const anyMsg: any = msg.message
        text = anyMsg.conversation || anyMsg.extendedTextMessage?.text || anyMsg.imageMessage?.caption || anyMsg.videoMessage?.caption || ''
        const pushName = (msg.pushName || msg.broadcast || '') as string | undefined
        const id = msg.key.id || `${Date.now()}`
        const timestamp = (Number(msg.messageTimestamp) || Date.now()) * 1000

        // Detecta se tem mídia
        let mediaType: string | undefined
        let mediaPath: string | undefined
        if (anyMsg.imageMessage) mediaType = 'image'
        else if (anyMsg.videoMessage) mediaType = 'video'
        else if (anyMsg.audioMessage) mediaType = 'audio'
        else if (anyMsg.documentMessage) mediaType = 'document'
        else if (anyMsg.stickerMessage) mediaType = 'sticker'

        if (mediaType && process.env.SAVE_MEDIA === '1') {
          try {
            const mediaDir = path.join(process.cwd(), 'data', 'media', sessionId)
            ensureDir(mediaDir)
            const stream = await downloadMediaMessage(msg, 'buffer', {}, {
              logger: pino({ level: 'silent' }),
              reuploadRequest: sock.updateMediaMessage
            })
            const ext = mediaType === 'image' ? 'jpg' : mediaType === 'video' ? 'mp4' : mediaType === 'audio' ? 'ogg' : mediaType === 'document' ? (anyMsg.documentMessage.fileName?.split('.').pop() || 'bin') : mediaType === 'sticker' ? 'webp' : 'bin'
            mediaPath = path.join(mediaDir, `${id}.${ext}`)
            fs.writeFileSync(mediaPath, stream as Buffer)
          } catch (e) {
            try { console.warn('[wa][media][fail]', sessionId, e) } catch {}
          }
        }

        const rec = { id, from, to: fromMe ? from : undefined, text, timestamp, fromMe, pushName, mediaType, mediaPath }
        sess.messages!.push(rec)
        if (sess.messages!.length > 500) sess.messages!.splice(0, sess.messages!.length - 500)
  appendMessage(sessionId, rec)
  indexMessage(rec as any)
        console.log(`[wa][msg][${sessionId}] ${fromMe ? '>>' : '<<'} ${from} ${mediaType ? '['+mediaType+'] ' : ''}${text ? '- ' + text.slice(0,120) : ''}`)
  broadcast(sessionId, 'message', rec)
        // Webhook
        if (process.env.WEBHOOK_URL) {
          try {
            const url = process.env.WEBHOOK_URL
            const payload = JSON.stringify({ event: 'message', session: sessionId, message: rec })
            const mod = url.startsWith('https') ? https : http
            const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res)=>{ res.resume() })
            req.on('error', ()=>{})
            req.write(payload)
            req.end()
          } catch {}
        }
      }
      if (type === 'notify') {
        // pode futuramente disparar webhook/evento
      }
    })

    // Atualizações de status de mensagens (ex: recebida, lida)
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        try {
          const status = (u.update.status !== undefined) ? String(u.update.status) : undefined
          if (status) {
            updateMessageStatus(sessionId, u.key.id!, status)
            broadcast(sessionId, 'message_status', { id: u.key.id, status })
          }
          console.log('[wa][msg.update]', sessionId, u.key.id, status)
        } catch {}
      }
    })

    // Recebidos indicadores de recibo (delivered/read)
    sock.ev.on('message-receipt.update', (receipts) => {
      try { console.log('[wa][receipt]', sessionId, receipts.length) } catch {}
    })

    // Atualizações de chats (metadados) - útil para depuração
    sock.ev.on('chats.upsert', (chats) => {
      try { console.log('[wa][chats.upsert]', sessionId, chats.length) } catch {}
    })
    sock.ev.on('contacts.upsert', (cts) => {
      try { console.log('[wa][contacts.upsert]', sessionId, cts.length) } catch {}
    })
  }

  boot().catch(() => {
    sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: 'error_init', qrDataUrl: null })
  })
}

// === API ORIGINAL ===
export function getQR(sessionId: string): string | null {
  const s = sessions.get(sessionId)
  // Enquanto estiver em processos de conexão/reconexão, devolver último QR disponível
  if (!s) return null
  if (s.qr) return s.qr
  return null
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

// Envio de mídia genérico
export async function sendMedia(sessionId: string, to: string, filePath: string, options: { caption?: string, mimetype?: string }) {
  const s = sessions.get(sessionId)
  if (!s?.sock) throw new Error('session_not_found')

  const jid = to.includes('@s.whatsapp.net') || to.includes('@g.us')
    ? to
    : `${to.replace(/\D/g, '')}@s.whatsapp.net`

  const buffer = fs.readFileSync(filePath)
  // Heurística simples de tipo
  const mime = options.mimetype || require('mime-types').lookup(filePath) || 'application/octet-stream'

  let message: any = { caption: options.caption }
  if (mime.startsWith('image/')) message.image = buffer
  else if (mime.startsWith('video/')) message.video = buffer
  else if (mime.startsWith('audio/')) message.audio = buffer
  else if (mime === 'image/webp') message.sticker = buffer
  else message.document = buffer, message.mimetype = mime, message.fileName = path.basename(filePath)

  await s.sock.sendMessage(jid, message)
}

// Novo: estado resumido da sessão
export function getStatus(sessionId: string) {
  // tenta global.sessoes se existir, depois fallback local
  const globalSessions: any = (global as any).sessions
  const s: Sess | undefined = globalSessions?.get?.(sessionId) ?? sessions.get(sessionId)
  return { state: s?.lastState ?? 'unknown', hasQR: !!s?.qrDataUrl }
}

export function getDebug(sessionId: string) {
  const s = sessions.get(sessionId)
  if(!s) return { exists:false }
  return {
    exists: true,
    state: s.lastState,
    hasQR: !!s.qrDataUrl,
    lastQRAt: s.lastQRAt,
    msSinceLastQR: s.lastQRAt? Date.now()-s.lastQRAt : null,
    starting: !!s.starting,
    startingSince: s.startingSince,
    msStarting: s.startingSince? Date.now()-s.startingSince : null,
    lastDisconnectCode: s.lastDisconnectCode,
    restartCount: s.restartCount||0,
    criticalCount: s.criticalCount||0,
    nextRetryAt: s.nextRetryAt || null,
    msUntilRetry: s.nextRetryAt ? Math.max(0, s.nextRetryAt - Date.now()) : null
  }
}

// Expor mensagens recentes (em memória)
export function getMessages(sessionId: string, limit = 100) {
  const s = sessions.get(sessionId)
  if(!s?.messages) return []
  return s.messages.slice(-limit)
}
