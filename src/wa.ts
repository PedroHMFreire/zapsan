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
import { EventEmitter } from 'events'

// Mantém comportamento antigo: pasta local "sessions".
// Em produção (ex.: Render) recomenda-se definir SESS_DIR para um caminho gravável/persistente (/data/sessions ou volume montado)
const SESS_DIR = process.env.SESS_DIR || path.resolve(process.cwd(), 'sessions')
// Garante existência imediata do diretório raiz e reporta (útil para diagnosticar ENOENT / read-only FS)
try {
  fs.mkdirSync(SESS_DIR, { recursive: true })
  // Log somente uma vez no boot
  // (console.log usado em vez de logger interno para aparecer cedo no Render)
  // eslint-disable-next-line no-console
  console.log('[wa][init] SESS_DIR', SESS_DIR)
} catch (err:any) {
  // eslint-disable-next-line no-console
  console.error('[wa][init][error_mkdir]', SESS_DIR, err?.message)
}

// Wrapper com retry para lidar com condição rara de ENOENT em init auth state (FS lento ou remoção concorrente)
async function prepareAuthState(baseDir:string){
  let lastErr:any
  for(let attempt=1; attempt<=3; attempt++){
    try {
      ensureDir(baseDir)
      const r = await useMultiFileAuthState(baseDir)
      if(attempt>1){
        // eslint-disable-next-line no-console
        console.warn('[wa][authstate][recovered]', { baseDir, attempt })
      }
      return r
    } catch(err:any){
      lastErr = err
      if(err?.code === 'ENOENT'){
        // eslint-disable-next-line no-console
        console.warn('[wa][authstate][retry]', { baseDir, attempt, code: err.code })
        await new Promise(r=>setTimeout(r, 50*attempt))
        continue
      }
      break
    }
  }
  throw lastErr
}

type Sess = {
  sock?: WASocket
  baseDir: string
  qr?: string | null
  starting?: boolean
  lastState?: string
  qrDataUrl?: string | null
  lastQRAt?: number
  firstQRAt?: number
  qrGenCount?: number
  startingSince?: number
  lastDisconnectCode?: number
  restartCount?: number
  criticalCount?: number
  nextRetryAt?: number
  // persisted meta snapshot fields (substitute for future expansion)
  metaPersisted?: boolean
  lastOpenAt?: number
  everOpened?: boolean
  messages?: Array<{
    id: string
    from: string
    to?: string
    text: string
    timestamp: number
    fromMe: boolean
    pushName?: string
  }>
  manualMode?: boolean
  scanGraceUntil?: number
}

const sessions = new Map<string, Sess>()
const isManualMode = () => process.env.MANUAL_PAIRING === '1'
// ---- Novos tipos e estruturas de sync simplificado ----
export type SessState = 'closed' | 'connecting' | 'open'
export type Msg = { id:string; from:string; to?:string; text?:string; fromMe?:boolean; timestamp:number }
const sessionState = new Map<string, SessState>()
const sessionMsgs  = new Map<string, Msg[]>()
const sessionBus   = new Map<string, EventEmitter>()

function busFor(id:string){ let b=sessionBus.get(id); if(!b){ b=new EventEmitter(); b.setMaxListeners(100); sessionBus.set(id,b) } return b }
function pushMsg(sessionId:string, m:Msg){
  const buf = sessionMsgs.get(sessionId) || []
  buf.push(m)
  if(buf.length>5000) buf.splice(0, buf.length-5000)
  sessionMsgs.set(sessionId, buf)
  busFor(sessionId).emit('message', m)
}
// expõe no global opcionalmente (usado por getStatus se disponível)
;(global as any).sessions = (global as any).sessions || sessions

const ensureDir = (dir: string) => {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
}
const nukeDir = (dir: string) => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

function loadMeta(baseDir: string){
  try {
    const p = path.join(baseDir, 'meta.json')
    const raw = fs.readFileSync(p,'utf8')
    return JSON.parse(raw) as { restartCount?: number; criticalCount?: number; lastDisconnectCode?: number; lastOpenAt?: number }
  } catch { return {} }
}
function saveMeta(sess: Sess){
  if(!sess?.baseDir) return
  try {
    const p = path.join(sess.baseDir, 'meta.json')
    const data = {
      restartCount: sess.restartCount||0,
      criticalCount: sess.criticalCount||0,
      lastDisconnectCode: sess.lastDisconnectCode||null,
      lastOpenAt: sess.lastOpenAt||null,
      lastState: sess.lastState||null,
      hasQR: !!sess.qrDataUrl,
      updatedAt: Date.now()
    }
    fs.writeFileSync(p, JSON.stringify(data,null,2),'utf8')
    sess.metaPersisted = true
  } catch {}
}

// === API ORIGINAL ===
// Dispara/recupera a sessão; não muda a assinatura original
export async function createOrLoadSession(sessionId: string): Promise<void> {
  if (!sessionId) throw new Error('session_id_required')

  const current = sessions.get(sessionId)
  if (current?.sock || current?.starting) return

  const baseDir = path.join(SESS_DIR, sessionId)
  ensureDir(baseDir)
  // load persisted meta if exists
  const meta = loadMeta(baseDir)
  const manual = isManualMode()
  sessions.set(sessionId, { baseDir, starting: true, startingSince: Date.now(), qr: null, restartCount: meta.restartCount || (current?.restartCount||0), criticalCount: meta.criticalCount || (current?.criticalCount || 0), lastDisconnectCode: meta.lastDisconnectCode, lastOpenAt: meta.lastOpenAt, manualMode: manual })
  sessionState.set(sessionId, 'connecting')

  const boot = async () => {
  const sess = sessions.get(sessionId)!
  // Usa wrapper resiliente para reduzir risco de ENOENT inicial (principalmente em FS em rede ou após nukeDir simultâneo)
  const { state, saveCreds } = await prepareAuthState(baseDir)

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
      try { console.log('[wa][update]', sessionId, { connection: u.connection, qr: !!u.qr, lastDisconnect: (u as any)?.lastDisconnect?.error?.message }) } catch {}
      if (u.connection) {
        sess.lastState = u.connection
        if(u.connection==='open') sessionState.set(sessionId,'open')
        else if(u.connection==='close') sessionState.set(sessionId,'closed')
        else if(u.connection==='connecting') sessionState.set(sessionId,'connecting')
      }
      // QR handling
      if (u.qr) {
        try {
          const dataUrl = await QRCode.toDataURL(u.qr, { margin: 0 })
          const changed = dataUrl !== sess.qrDataUrl
          if(changed){
            sess.qr = dataUrl
            sess.qrDataUrl = dataUrl
            sess.lastQRAt = Date.now()
            if(!sess.firstQRAt) sess.firstQRAt = sess.lastQRAt
            sess.qrGenCount = (sess.qrGenCount||0)+1
            if(sess.manualMode){
              const grace = Number(process.env.SCAN_GRACE_MS || 25000)
              sess.scanGraceUntil = Date.now() + grace
            }
            console.warn('[wa][qr][new]', sessionId, { qrGenCount: sess.qrGenCount, sinceFirstMs: sess.firstQRAt? Date.now()-sess.firstQRAt: null, manual: !!sess.manualMode })
          }
          if(!sess.manualMode){
            // Auto-reset condicional (apenas modo automático)
            const maxQrEnv = Number(process.env.QR_MAX_BEFORE_RESET || 8)
            const maxMsEnv = Number(process.env.QR_MAX_AGE_BEFORE_RESET || 120_000)
            const autoResetEnabled = maxQrEnv > 0 && maxMsEnv > 0
            if(autoResetEnabled && !sess.everOpened){
              const tookTooMany = (sess.qrGenCount||0) >= maxQrEnv
              const tooOld = sess.firstQRAt && (Date.now()-sess.firstQRAt) > maxMsEnv
              if(tookTooMany || tooOld){
                console.warn('[wa][qr][auto-reset]', sessionId, { qrGenCount: sess.qrGenCount, msSinceFirst: sess.firstQRAt? Date.now()-sess.firstQRAt: null, tookTooMany, tooOld })
                try { nukeDir(sess.baseDir) } catch {}
                const restartCount = (sess.restartCount||0)+1
                sessions.set(sessionId, { baseDir: sess.baseDir, starting: false, qr: null, lastState: 'restarting', restartCount, criticalCount: sess.criticalCount, qrDataUrl: null, nextRetryAt: Date.now()+1500 })
                setTimeout(()=>createOrLoadSession(sessionId).catch(()=>{}), 1500)
                return
              }
            }
          }
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
        sess.lastOpenAt = Date.now()
        sess.everOpened = true
        saveMeta(sess)
      }

      if (u.connection === 'close') {
        const code =
          (u.lastDisconnect?.error as any)?.output?.statusCode ||
          (u.lastDisconnect?.error as any)?.status || 0
        sess.lastDisconnectCode = code
        saveMeta(sess)

        const isStreamErrored =
          code === 515 || (u.lastDisconnect?.error as any)?.message?.includes('Stream Errored')

        const isLoggedOut =
          code === 401 ||
          (u.lastDisconnect?.error as any)?.output?.statusCode === DisconnectReason.loggedOut

        // >>> Correção 2: em 515/401, resetar credenciais e re-parear
  if (!sess.manualMode && (isStreamErrored || isLoggedOut)) {
          const crit = (sess.criticalCount||0)+1
          sess.criticalCount = crit
          // base backoff exponencial simples: 3s * 2^(crit-1), cap 30s
          let base = Math.min(30000, 3000 * Math.pow(2, Math.max(0, crit-1)))
          // jitter 0–25%
          const delay = Math.round(base * (1 + Math.random()*0.25))
          // Heurística: se NUNCA abriu (sem everOpened) e já deu 2x 515 -> nuke para forçar QR totalmente novo
          const neverOpened = !sess.everOpened
          const shouldNuke = isLoggedOut || crit >= 3 || (neverOpened && crit >=2) || crit > 6
          console.warn('[wa][disconnect-critical]', sessionId, { code, crit, delay, everOpened: !!sess.everOpened, willNuke: shouldNuke })
          if (shouldNuke) {
            try { nukeDir(baseDir) } catch {}
          }
          const restartCount = (sess.restartCount||0)+1
          sessions.set(sessionId, { baseDir, starting: false, qr: sess.qr || null, lastState: 'restarting', qrDataUrl: sess.qrDataUrl || null, restartCount, criticalCount: sess.criticalCount, nextRetryAt: Date.now()+delay, lastDisconnectCode: sess.lastDisconnectCode, lastOpenAt: sess.lastOpenAt, everOpened: sess.everOpened })
          const ns = sessions.get(sessionId)
          if(ns) saveMeta(ns)
          setTimeout(() => createOrLoadSession(sessionId).catch(() => {}), delay)
          return
        }

        // outros motivos (timeout, rede etc) → tenta reconectar preservando auth
        // reconexão leve (rede): manter QR se ainda não conectou / útil para pairing
        if(!sess.manualMode){
          const lightDelay = 10000
          const restartCount = (sess.restartCount||0)+1
          sessions.set(sessionId, { baseDir, starting: false, qr: sess.qr || null, lastState: 'reconnecting', qrDataUrl: sess.qrDataUrl || null, restartCount, criticalCount: sess.criticalCount||0, nextRetryAt: Date.now()+lightDelay, lastDisconnectCode: sess.lastDisconnectCode, lastOpenAt: sess.lastOpenAt })
          const ns = sessions.get(sessionId)
          if(ns) saveMeta(ns)
          setTimeout(() => createOrLoadSession(sessionId).catch(() => {}), lightDelay)
        } else {
          // Modo manual: não reconectar automaticamente
          sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: 'waiting_manual_retry', qrDataUrl: null, restartCount: sess.restartCount, criticalCount: sess.criticalCount, lastDisconnectCode: sess.lastDisconnectCode, manualMode: true })
        }
      }
    })

    // Listener principal de mensagens
    sock.ev.on('messages.upsert', async ({ messages }) => {
      if(!messages?.length) return
      for(const m of messages){
        const id   = m.key?.id || String(Date.now())
        const from = m.key?.remoteJid || ''
        const fromMe = !!m.key?.fromMe
        const text = m.message?.conversation
                  || (m.message as any)?.extendedTextMessage?.text
                  || (m.message as any)?.imageMessage?.caption
                  || (m.message as any)?.videoMessage?.caption
                  || ''
        const to   = fromMe ? ( (m.key as any)?.participant || from) : undefined
        const ts   = (m.messageTimestamp ? Number(m.messageTimestamp) : Date.now()) * 1000
        pushMsg(sessionId, { id, from, to, text, fromMe, timestamp: ts })
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

// Cria sessão em estado idle (apenas se não existir) - usado em modo manual
export function createIdleSession(sessionId: string){
  if(!sessionId) throw new Error('session_id_required')
  const existing = sessions.get(sessionId)
  if(existing) return { ok:true, existed:true }
  const baseDir = path.join(SESS_DIR, sessionId)
  ensureDir(baseDir)
  sessions.set(sessionId, { baseDir, manualMode: true, lastState: 'idle', messages: [] })
  return { ok:true, existed:false }
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
  const maxQrEnv = Number(process.env.QR_MAX_BEFORE_RESET || 8)
  const maxMsEnv = Number(process.env.QR_MAX_AGE_BEFORE_RESET || 120_000)
  const autoResetEnabled = maxQrEnv > 0 && maxMsEnv > 0
  const scanGraceRemaining = s.scanGraceUntil ? Math.max(0, s.scanGraceUntil - Date.now()) : null
  return {
    exists: true,
    state: s.lastState,
    hasQR: !!s.qrDataUrl,
    lastQRAt: s.lastQRAt,
    msSinceLastQR: s.lastQRAt? Date.now()-s.lastQRAt : null,
    firstQRAt: s.firstQRAt || null,
    msSinceFirstQR: s.firstQRAt? Date.now()-s.firstQRAt : null,
    qrGenCount: s.qrGenCount||0,
    starting: !!s.starting,
    startingSince: s.startingSince,
    msStarting: s.startingSince? Date.now()-s.startingSince : null,
    lastDisconnectCode: s.lastDisconnectCode,
    restartCount: s.restartCount||0,
    criticalCount: s.criticalCount||0,
    nextRetryAt: s.nextRetryAt || null,
    msUntilRetry: s.nextRetryAt ? Math.max(0, s.nextRetryAt - Date.now()) : null,
    lastOpenAt: s.lastOpenAt || null,
    autoResetEnabled,
    qrMaxBeforeReset: maxQrEnv,
    qrMaxAgeMsBeforeReset: maxMsEnv,
    manualMode: !!s.manualMode,
    scanGraceUntil: s.scanGraceUntil||null,
    scanGraceRemaining,
  }
}

// Expor mensagens recentes (em memória)
// (mantido por compat interna) mensagens antigas em memória curta
function getMessagesLegacy(sessionId: string, limit = 100) {
  const s = sessions.get(sessionId)
  if(!s?.messages) return []
  return s.messages.slice(-limit)
}

// List meta for all sessions (for metrics)
export function getAllSessionMeta(){
  const out: Record<string, any> = {}
  for(const [id, s] of sessions.entries()){
    out[id] = {
      state: s.lastState || 'unknown',
      restartCount: s.restartCount||0,
      criticalCount: s.criticalCount||0,
      lastDisconnectCode: s.lastDisconnectCode||null,
      lastOpenAt: s.lastOpenAt||null,
      hasQR: !!s.qrDataUrl,
      messagesInMemory: s.messages?.length||0
    }
  }
  return out
}

// Efetua logout (se possível) e remove credenciais para forçar novo pareamento limpo
export async function cleanLogout(sessionId: string, { keepMessages = false }: { keepMessages?: boolean } = {}) {
  const sess = sessions.get(sessionId)
  if (!sess) return { ok: false, reason: 'not_found' }
  try {
    if (sess.sock) {
      try { await sess.sock.logout?.() } catch {}
      try { sess.sock.ws.close() } catch {}
    }
  } catch {}
  // Remover diretório de credenciais
  try { nukeDir(sess.baseDir) } catch {}
  // Preservar mensagens em memória opcionalmente
  const preservedMsgs = keepMessages ? (sess.messages ? [...sess.messages] : []) : undefined
  sessions.delete(sessionId)
  if (keepMessages) {
    // Recria placeholder da sessão somente com mensagens preservadas (sem sock)
    sessions.set(sessionId, { baseDir: path.join(SESS_DIR, sessionId), messages: preservedMsgs })
  }
  return { ok: true }
}

// Remove TODAS as sessões (memória + diretórios). Uso cuidadoso.
export function nukeAllSessions(){
  for(const [id, s] of Array.from(sessions.entries())){
    try { s.sock?.logout?.() } catch {}
    try { s.sock?.ws.close() } catch {}
    try { nukeDir(s.baseDir) } catch {}
    sessions.delete(id)
  }
  return { ok:true }
}

// ==== Novos helpers públicos solicitados ====
export function getSessionStatus(sessionId: string): { state: SessState } {
  return { state: sessionState.get(sessionId) || 'closed' }
}
export function getMessages(sessionId: string, limit = 500): Msg[] {
  const all = sessionMsgs.get(sessionId) || []
  const n = Math.max(1, Math.min(5000, Number(limit)||500))
  return all.slice(-n)
}
export function onMessageStream(sessionId: string, cb: (m: Msg)=>void): () => void {
  const b = busFor(sessionId)
  const fn = (m: Msg) => cb(m)
  b.on('message', fn)
  return () => b.off('message', fn)
}
