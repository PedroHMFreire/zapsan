import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import { logger } from './logger'
import { ensureDir, resolveSessionPath } from './utils'
import { reply } from './ai'

type SessionData = {
  sock?: WASocket
  qrDataUrl?: string | null
  lastState?: string
  retries?: number
}

const sessions = new Map<string, SessionData>()

export async function createOrLoadSession(sessionId: string) {
  // Reutiliza socket existente
  const existing = sessions.get(sessionId)?.sock
  if (existing) return existing

  const dir = resolveSessionPath(sessionId)
  ensureDir(dir)

  const { state, saveCreds } = await useMultiFileAuthState(dir)
  const { version } = await fetchLatestBaileysVersion()

  const shouldSyncHistoryMessage = false

  const sock = makeWASocket({
    auth: state,
    version, // evita problemas de protocolo
    printQRInTerminal: false,
    browser: ['ZapSan', 'Chrome', '1.0.0'],
    connectTimeoutMs: 30_000,
    defaultQueryTimeoutMs: 30_000,
    // @ts-expect-error flag suportada em versões recentes; evita sync pesado inicial
    shouldSyncHistoryMessage,
  })

  sessions.set(sessionId, { sock, qrDataUrl: null, lastState: 'connecting', retries: 0 })

  // Salvar credenciais SEMPRE
  sock.ev.on('creds.update', saveCreds)

  // Estado de conexão + QR
  sock.ev.on('connection.update', async (update) => {
    const sref = sessions.get(sessionId)
    if (!sref) return

    const code = (update.lastDisconnect?.error as any)?.output?.statusCode
    const message = (update.lastDisconnect?.error as any)?.message
    console.debug('DEBUG connection.update:', {
      connection: update.connection,
      isOnline: (update as any)?.isOnline,
      receivedPendingNotifications: (update as any)?.receivedPendingNotifications,
      code,
      message,
    })

    if (update.qr) {
      try {
        sref.qrDataUrl = await QRCode.toDataURL(update.qr)
        logger.info({ sessionId }, 'QR atualizado')
        // (opcional) ASCII no terminal se qrcode-terminal estiver instalado
        try {
          // @ts-ignore - import dinâmico opcional
          const qrt = await import('qrcode-terminal')
          qrt.default?.generate
            ? qrt.default.generate(update.qr, { small: true })
            : qrt.generate(update.qr, { small: true })
        } catch {}
      } catch (err: any) {
        logger.error({ err }, 'Falha ao gerar dataURL do QR')
      }
    }

    if (update.connection) {
      sref.lastState = update.connection
      logger.info({ sessionId, connection: update.connection }, 'connection.update')
    }

    if (update.connection === 'open') {
      sref.qrDataUrl = null // limpamos o QR quando abriu
      sref.retries = 0
      logger.info({ sessionId }, 'Conexão aberta (QR limpo)')
    }

    if (update.connection === 'close') {
      logger.warn({ sessionId, code, message }, 'Conexão fechada')
      const retriable = [408, 410, 515].includes(code)
      if (code === 401) {
        logger.error({ sessionId }, 'Credenciais inválidas/expiradas: apague a pasta sessions/' + sessionId + ' e refaça o pareamento.')
        return
      }
      if (retriable) {
        const delay = 1500
        const attempt = (sref.retries = (sref.retries || 0) + 1)
        if (attempt > 8) {
          logger.error({ sessionId, attempt }, 'Limite de tentativas (simples) atingido — parar')
          return
        }
        logger.info({ sessionId, code, attempt, delay }, 'Retry programado')
        setTimeout(() => createOrLoadSession(sessionId).catch(err => logger.error({ err, sessionId }, 'Falha ao reconectar')), delay)
      }
    }
  })

  // Mensagens recebidas -> IA
  sock.ev.on('messages.upsert', async (evt) => {
    const msg = evt.messages?.[0]
    if (!msg || msg.key.fromMe) return

    const from = msg.key.remoteJid || ''
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      ''

    if (!text.trim()) return

    try {
      const answer = await reply({ text, from, sessionId })
      await sock.sendMessage(from, { text: answer })
      logger.info({ sessionId, from }, 'IA respondeu')
    } catch (err: any) {
      logger.error({ err, sessionId }, 'Falha ao responder via IA')
    }
  })

  return sock
}

export function getQR(sessionId: string): string | null {
  const s = sessions.get(sessionId)
  return s?.qrDataUrl || null
}

export async function sendText(sessionId: string, to: string, text: string) {
  const s = sessions.get(sessionId)
  if (!s?.sock) throw new Error('session_not_found')
  await s.sock.sendMessage(to, { text })
}

// Handlers globais (captura erros silenciosos)
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION', e))
process.on('uncaughtException', (e) => console.error('UNCAUGHT EXCEPTION', e))
