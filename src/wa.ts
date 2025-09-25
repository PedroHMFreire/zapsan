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
import { supa } from './db'
import http from 'http'
import https from 'https'
import { EventEmitter } from 'events'
import { processMedia, MediaInfo } from './mediaProcessor'
import { createPersistentAuthState, saveAuthToSupabase } from './persistentAuth'
import { reply } from './ai'

// 📊 Helper to get userId from sessionId
async function getUserIdFromSession(sessionId: string): Promise<string | null> {
  try {
    const { data, error } = await supa
      .from('sessions')
      .select('user_id')
      .eq('session_id', sessionId)
      .single()
    
    if (error || !data) return null
    return data.user_id || null
  } catch (error) {
    console.warn('Failed to get userId from session:', error)
    return null
  }
}

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
async function prepareAuthState(baseDir:string, sessionId: string){
  let attempt = 0
  while(attempt < 3){
    try {
      ensureDir(baseDir)
      
      // Usar sistema persistente que tenta local primeiro, depois Supabase
      const persistentAuth = createPersistentAuthState(sessionId)
      await persistentAuth.loadState()
      
      // Converter para formato esperado pelo Baileys
      const authState = {
        state: {
          creds: persistentAuth.state.creds,
          keys: persistentAuth.state.keys
        },
        saveCreds: async () => {
          persistentAuth.state.creds = authState.state.creds
          persistentAuth.state.keys = authState.state.keys
          await persistentAuth.saveState()
        }
      }
      
      // Se não tem credenciais, usar useMultiFileAuthState padrão
      if (!authState.state.creds) {
        const standardAuth = await useMultiFileAuthState(baseDir)
        
        // Converter para nosso formato persistente
        authState.state = standardAuth.state
        authState.saveCreds = async () => {
          await standardAuth.saveCreds()
          // Também salvar no Supabase
          persistentAuth.state.creds = authState.state.creds
          persistentAuth.state.keys = authState.state.keys
          await persistentAuth.saveState()
        }
      }
      
      if(authState?.state?.creds){
        console.warn('[wa][authstate][recovered]', { baseDir, attempt, hasCreds: !!authState.state.creds })
      }
      return authState
    } catch (err: any) {
      attempt++
      if(err.code === 'ENOENT'){
        console.warn('[wa][authstate][retry]', { baseDir, attempt, code: err.code })
        await new Promise(r => setTimeout(r, 500 * attempt))
      } else {
        throw err
      }
    }
  }
  throw new Error(`authstate_failed_after_${attempt}_attempts`)
}type Sess = {
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
  // 🤖 Estado da IA
  aiEnabled?: boolean
  aiToggledBy?: string
  aiToggledAt?: number
}

const sessions = new Map<string, Sess>()
const isManualMode = () => process.env.MANUAL_PAIRING === '1'

// Função para validar formato brasileiro obrigatório: 55 + DDD + 9 + 8 dígitos
function normalizeBrazilianPhone(phone: string): string {
  // Remove todos os caracteres não numéricos
  const digits = phone.replace(/\D/g, '')
  
  // Deve ter exatamente 13 dígitos (55 + 2 DDD + 1 nono dígito + 8 números)
  if (digits.length !== 13) {
    throw new Error('Número deve ter 13 dígitos: 55 + DDD + 9 + 8 números')
  }
  
  // Deve começar com 55 (código do Brasil)
  if (!digits.startsWith('55')) {
    throw new Error('Número deve começar com 55 (código do Brasil)')
  }
  
  // Extrai DDD (dígitos 3 e 4)
  const ddd = digits.slice(2, 4)
  const dddNumber = parseInt(ddd)
  
  // Verifica se é um DDD válido (11-99)
  if (dddNumber < 11 || dddNumber > 99) {
    throw new Error('DDD inválido. Deve estar entre 11 e 99')
  }
  
  // Verifica se o 5º dígito é 9 (nono dígito obrigatório para celulares)
  const ninthDigit = digits[4]
  if (ninthDigit !== '9') {
    throw new Error('Número de celular deve ter o 9º dígito. Formato: 55 + DDD + 9 + 8 números')
  }
  
  // Se passou por todas as validações, retorna o número
  return digits
}
// ---- Novos tipos e estruturas de sync simplificado ----
export type SessState = 'closed' | 'connecting' | 'open'
export type Msg = { id:string; from:string; to?:string; text?:string; fromMe?:boolean; timestamp:number }
const sessionState = new Map<string, SessState>()
const sessionMsgs  = new Map<string, Msg[]>()
const sessionBus   = new Map<string, EventEmitter>()
// Dedupe simples para evitar upsert repetido do mesmo contato
const contactsSeen = new Map<string, Set<string>>()

function seenSetFor(id: string){
  let s = contactsSeen.get(id)
  if(!s){ s = new Set<string>(); contactsSeen.set(id, s) }
  return s
}

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

// Helper: detecta se já existe credencial (pareado previamente)
function hasCreds(dir: string){
  try { return fs.existsSync(path.join(dir, 'creds.json')) } catch { return false }
}

// Sinalização de start manual: somente quando presente permitimos iniciar socket sem credenciais
const manualStartRequests = new Set<string>()
export function allowManualStart(sessionId: string){
  manualStartRequests.add(sessionId)
  // Evita ficar preso indefinidamente; expira em 60s
  setTimeout(()=>manualStartRequests.delete(sessionId), 60_000)
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
  // Verifica credenciais existentes e pedido manual
  const credsPresent = hasCreds(baseDir)
  const manualRequested = manualStartRequests.has(sessionId)
  // Upsert sessão status somente quando realmente vamos iniciar conexão
  if(credsPresent || manualRequested){
    try {
      const { error } = await supa.from('sessions').upsert(
        { session_id: sessionId, status: 'connecting' },
        { onConflict: 'session_id' }
      )
      if(error) console.warn('[wa][supa][session_upsert_connecting][warn]', sessionId, error.message)
    } catch (err:any) { console.warn('[wa][supa][session_upsert_connecting][catch]', sessionId, err?.message) }
  }
  // Hidratar histórico persistido (se ainda não carregado em sessionMsgs)
  try {
    if(!sessionMsgs.get(sessionId)){
      const dataFile = path.join(process.cwd(), 'data', 'messages', `${sessionId}.json`)
      if(fs.existsSync(dataFile)){
        const raw = fs.readFileSync(dataFile,'utf8')
        const parsed = JSON.parse(raw)
        if(Array.isArray(parsed.messages)){
          const restored: Msg[] = parsed.messages.map((m:any)=>({
            id: String(m.id||''),
            from: String(m.from||''),
            to: m.to? String(m.to): undefined,
            text: m.text? String(m.text): '',
            fromMe: !!m.fromMe,
            timestamp: typeof m.timestamp==='number'? m.timestamp : Date.now()
          })).filter((x: Msg)=>x.id && x.from)
          if(restored.length){
            const MAX=5000
            const slice = restored.slice(-MAX)
            sessionMsgs.set(sessionId, slice)
            // Reindexar (best-effort)
            try { slice.forEach(r=>{ try { indexMessage({ id:r.id, from:r.from, to:r.to, text:r.text||'', timestamp:r.timestamp, fromMe: !!r.fromMe }) } catch{} }) } catch {}
            console.log('[wa][hydrate]', sessionId, { restored: slice.length })
          }
        }
      }
    }
  } catch (err:any){ console.warn('[wa][hydrate][error]', sessionId, err?.message) }
  // load persisted meta if exists
  const meta = loadMeta(baseDir)
  const manual = isManualMode()
  // Se não há credenciais e não foi solicitado manualmente, não iniciar para não gerar QR automaticamente
  if(!credsPresent && !manualRequested){
    const prev = sessions.get(sessionId)
    sessions.set(sessionId, { baseDir, starting: false, qr: null, lastState: prev?.lastState || 'idle', restartCount: meta.restartCount || (current?.restartCount||0), criticalCount: meta.criticalCount || (current?.criticalCount || 0), lastDisconnectCode: meta.lastDisconnectCode, lastOpenAt: meta.lastOpenAt, manualMode: manual, messages: prev?.messages||[] })
    sessionState.set(sessionId, 'closed')
    try { await supa.from('sessions').upsert({ session_id: sessionId, status: 'closed' }, { onConflict: 'session_id' }) } catch {}
    return
  }

  sessions.set(sessionId, { baseDir, starting: true, startingSince: Date.now(), qr: null, restartCount: meta.restartCount || (current?.restartCount||0), criticalCount: meta.criticalCount || (current?.criticalCount || 0), lastDisconnectCode: meta.lastDisconnectCode, lastOpenAt: meta.lastOpenAt, manualMode: manual })
  sessionState.set(sessionId, 'connecting')

  const boot = async () => {
  const sess = sessions.get(sessionId)!
  // Usa wrapper resiliente para reduzir risco de ENOENT inicial (principalmente em FS em rede ou após nukeDir simultâneo)
  const { state, saveCreds } = await prepareAuthState(baseDir, sessionId)

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
    // Consome o pedido manual (se existia)
    if(manualStartRequests.has(sessionId)) manualStartRequests.delete(sessionId)
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
              const grace = Number(process.env.SCAN_GRACE_MS || 20000)
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
                setTimeout(()=>createOrLoadSession(sessionId).catch(()=>{}), 15000)
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
        // atualizar status no banco
        try {
          const { error } = await supa.from('sessions').upsert(
            { session_id: sessionId, status: 'open' },
            { onConflict: 'session_id' }
          )
          if(error) console.warn('[wa][supa][session_status_open][warn]', sessionId, error.message)
        } catch(e:any){ console.warn('[wa][supa][session_status_open][catch]', sessionId, e?.message) }
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
        // persistir status closed
        try {
          const { error } = await supa.from('sessions').upsert(
            { session_id: sessionId, status: 'closed' },
            { onConflict: 'session_id' }
          )
          if(error) console.warn('[wa][supa][session_status_closed][warn]', sessionId, error.message)
        } catch(e:any){ /* silencioso */ }
      }
    })

    // Listener principal de mensagens
    sock.ev.on('messages.upsert', async ({ messages }) => {
      if(!messages?.length) return
      for(const m of messages){
        try {
          const id   = m.key?.id || String(Date.now())
          const from = m.key?.remoteJid || ''
          const fromMe = !!m.key?.fromMe
          
          // Verificar se tem mídia
          const hasMedia = !!(
            (m.message as any)?.imageMessage ||
            (m.message as any)?.videoMessage ||
            (m.message as any)?.audioMessage ||
            (m.message as any)?.documentMessage ||
            (m.message as any)?.stickerMessage
          )
          
          let text = m.message?.conversation
                    || (m.message as any)?.extendedTextMessage?.text
                    || (m.message as any)?.imageMessage?.caption
                    || (m.message as any)?.videoMessage?.caption
                    || ''
          
          let mediaInfo: MediaInfo | null = null
          
          // Processar mídia se existir
          if (hasMedia && !fromMe) { // Processar mídias recebidas
            try {
              const buffer = await downloadMediaMessage(m, 'buffer', {})
              if (buffer) {
                // Salvar arquivo temporário
                const tempDir = path.join(process.cwd(), 'data', 'temp')
                fs.mkdirSync(tempDir, { recursive: true })
                
                let extension = '.bin'
                let mimetype = 'application/octet-stream'
                
                if ((m.message as any)?.imageMessage) {
                  mimetype = (m.message as any).imageMessage.mimetype || 'image/jpeg'
                  extension = mimetype.includes('png') ? '.png' : 
                             mimetype.includes('webp') ? '.webp' : '.jpg'
                } else if ((m.message as any)?.videoMessage) {
                  mimetype = (m.message as any).videoMessage.mimetype || 'video/mp4'
                  extension = '.mp4'
                } else if ((m.message as any)?.audioMessage) {
                  mimetype = (m.message as any).audioMessage.mimetype || 'audio/ogg'
                  extension = '.ogg'
                } else if ((m.message as any)?.documentMessage) {
                  const doc = (m.message as any).documentMessage
                  mimetype = doc.mimetype || 'application/octet-stream'
                  extension = path.extname(doc.fileName || '') || '.bin'
                }
                
                const tempFilePath = path.join(tempDir, `${id}${extension}`)
                fs.writeFileSync(tempFilePath, buffer)
                
                // Processar mídia para gerar thumbnails
                mediaInfo = await processMedia(tempFilePath, mimetype)
                
                // Definir texto para mídia se não tiver caption
                if (!text) {
                  text = hasMedia ? `📎 ${mediaInfo.filename}` : ''
                }
              }
            } catch (mediaError) {
              console.warn('[wa][media][process][warn]', sessionId, mediaError)
              text = text || '📎 Mídia'
            }
          }
          
          const to   = fromMe ? ( (m.key as any)?.participant || from) : undefined
          // Baileys timestamp vem em segundos (normalmente). Convertemos para ms apenas se parecer razoável.
          let tsRaw = m.messageTimestamp ? Number(m.messageTimestamp) : (Date.now()/1000)
          if(tsRaw < 10_000_000_000) { // heurística: se ainda em segundos
            tsRaw = tsRaw * 1000
          }
          const ts = Math.floor(tsRaw)
          
          const msgObj = { 
            id, from, to, text, fromMe, timestamp: ts,
            ...(mediaInfo && {
              mediaType: mediaInfo.type,
              mediaPath: mediaInfo.originalPath,
              thumbnailPath: mediaInfo.thumbnailPath,
              previewPath: mediaInfo.previewPath,
              mediaInfo: {
                type: mediaInfo.type,
                mimetype: mediaInfo.mimetype,
                size: mediaInfo.size,
                width: mediaInfo.width,
                height: mediaInfo.height,
                duration: mediaInfo.duration,
                filename: mediaInfo.filename
              }
            })
          }
          
          pushMsg(sessionId, msgObj)

          // Auto-cadastro do contato no primeiro contato (leve e idempotente)
          try {
            if(!fromMe && from){
              const seen = seenSetFor(sessionId)
              if(!seen.has(from)){
                seen.add(from)
                const isGroup = from.endsWith('@g.us')
                const numberOrJid = from.replace(/@.*/, '')
                const provisionalName = isGroup ? null : ((m.pushName as any) || numberOrJid)
                try {
                  const { error } = await supa.from('contacts').upsert(
                    { session_key: sessionId, jid: from, name: provisionalName, is_group: isGroup },
                    { onConflict: 'session_key,jid' }
                  )
                  if(!error){
                    try { broadcast(sessionId, 'contact_upsert', { jid: from, name: provisionalName, is_group: isGroup }) } catch {}
                  }
                } catch {}
              }
            }
          } catch {}
          // Persistir em disco e indexar para busca/histórico
          try { appendMessage(sessionId, { ...msgObj, text, fromMe }) } catch {}
          try { indexMessage({ id, from, to, text, timestamp: ts, fromMe }) } catch {}
          // Persistir em Postgres
          try {
            const waMsgId = id
            const jid = from
            const body = text || null
            // Converte timestamp ms para Date
            const tsDate = new Date(ts)
            // Supabase insert de mensagem
            const { error: msgErr } = await supa.from('messages').insert({
              session_key: sessionId,
              jid,
              wa_msg_id: waMsgId,
              from_me: fromMe,
              body: body,
              timestamp: tsDate,
              raw: m as any
            })
            if(msgErr){
              if(!/duplicate|unique/i.test(msgErr.message)){
                console.warn('[wa][supa][message_insert][warn]', sessionId, msgErr.message)
              }
            }
          } catch (e:any) {
            // Evitar spam massivo: log só mensagem resumida
            if(!/Unique constraint|Foreign key/.test(e?.message||'')){
              console.warn('[wa][prisma][message_create][warn]', sessionId, e?.message)
            }
          }

          // 🤖 RESPOSTA AUTOMÁTICA DA IA (apenas para mensagens recebidas)
          const sess = sessions.get(sessionId)
          const aiGlobalEnabled = process.env.AI_AUTO_REPLY !== '0'
          const aiSessionEnabled = sess?.aiEnabled !== false // Por padrão ativado
          
          if (!fromMe && text && text.trim() && aiGlobalEnabled && aiSessionEnabled) {
            try {
              console.log(`[wa][ai][trigger] ${from}: "${text.slice(0, 50)}..."`)
              
              // Get userId for personalized AI response
              const userId = await getUserIdFromSession(sessionId)
              
              // Chamar IA com contexto da mensagem
              const aiResponse = await reply({
                text: text.trim(),
                from,
                sessionId,
                timestamp: ts,
                userId: userId || undefined
              })
              
              if (aiResponse && aiResponse.trim()) {
                // Enviar resposta automática
                const jidFormatted = from.includes('@') ? from : `${from}@s.whatsapp.net`
                await sock.sendMessage(jidFormatted, { text: aiResponse })
                
                console.log(`[wa][ai][sent] → ${from}: "${aiResponse.slice(0, 50)}..."`)
                
                // Registrar mensagem enviada pela IA
                const aiMsgId = `ai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
                const aiMsgObj = {
                  id: aiMsgId,
                  from: sock.user?.id || sessionId,
                  to: from,
                  text: aiResponse,
                  fromMe: true,
                  timestamp: Date.now()
                }
                
                // Salvar no store e broadcast
                pushMsg(sessionId, aiMsgObj)
                try { appendMessage(sessionId, { ...aiMsgObj, fromMe: true }) } catch {}
                try { broadcast(sessionId, 'message', aiMsgObj) } catch {}
              }
            } catch (aiError: any) {
              console.warn('[wa][ai][error]', sessionId, from, aiError?.message)
              // Em caso de erro da IA, não trava o fluxo normal
            }
          } else if (!fromMe && text && text.trim()) {
            // Log quando IA está desabilitada
            if (!aiGlobalEnabled) {
              console.log(`[wa][ai][disabled_global] ${from}: "${text.slice(0, 30)}..." (AI_AUTO_REPLY=0)`)
            } else if (!aiSessionEnabled) {
              console.log(`[wa][ai][disabled_session] ${from}: "${text.slice(0, 30)}..." (atendente assumiu)`)
            }
          }
        } catch(err:any){
          try { console.warn('[wa][messages.upsert][err]', sessionId, err && (err as any).message) } catch {}
        }
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
    sock.ev.on('contacts.upsert', async (cts) => {
      try { console.log('[wa][contacts.upsert]', sessionId, cts.length) } catch {}
      try {
        for(const c of cts){
          try {
            const { error: cErr } = await supa.from('contacts').upsert(
              { session_key: sessionId, jid: c.id, name: (c as any).notify || (c as any).name || null, is_group: false },
              { onConflict: 'session_key,jid' }
            )
            if(cErr) {/* silencioso por item */}
          } catch (e:any){ /* ignorar individuais */ }
        }
      } catch (e:any){ console.warn('[wa][prisma][contacts_upsert][warn]', sessionId, e?.message) }
    })
    // Tipagem de Baileys nem sempre expõe 'chats.set'; usar cast para compat
    ;(sock.ev as any).on('chats.set', async (payload: any) => {
      const chats = payload?.chats || []
      try { console.log('[wa][chats.set]', sessionId, chats.length) } catch {}
      try {
        for(const ch of chats){
          const isGroup = ch?.id?.endsWith?.('@g.us')
            try {
              const { error: cErr } = await supa.from('contacts').upsert(
                { session_key: sessionId, jid: ch.id, name: ch.name || ch.id, is_group: isGroup },
                { onConflict: 'session_key,jid' }
              )
              if(cErr){ /* ignorar individuais */ }
            } catch (e:any){ /* ignorar individuais */ }
        }
      } catch (e:any){ console.warn('[wa][prisma][chats_set][warn]', sessionId, e?.message) }
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

  let jid: string
  if (to.includes('@s.whatsapp.net') || to.includes('@g.us')) {
    jid = to
  } else {
    try {
      // Valida formato brasileiro obrigatório: 55 + DDD + 9 + 8 dígitos
      const normalizedPhone = normalizeBrazilianPhone(to)
      jid = `${normalizedPhone}@s.whatsapp.net`
    } catch (error: any) {
      console.log(`[sendText] ❌ Erro de validação: ${error.message}`)
      throw new Error(`Formato de número inválido: ${error.message}`)
    }
  }

  console.log(`[sendText] Original: ${to} → Normalizado: ${jid}`)
  console.log(`[sendText] Enviando para ${jid}: ${text}`)
  
  try {
    await s.sock.sendMessage(jid, { text })
    console.log(`[sendText] ✅ Mensagem enviada com sucesso para ${jid}`)
  } catch (error: any) {
    console.error(`[sendText] ❌ Erro ao enviar para ${jid}:`, error.message)
    throw error
  }
}

// Buscar foto de perfil de um contato
export async function getProfilePicture(sessionId: string, jid: string, type: 'preview' | 'image' = 'preview'): Promise<string | null> {
  const s = sessions.get(sessionId)
  if (!s?.sock) throw new Error('session_not_found')

  try {
    const profileUrl = await s.sock.profilePictureUrl(jid, type)
    return profileUrl || null
  } catch (error: any) {
    // Se não existe foto de perfil, Baileys retorna erro 404
    if (error.output?.statusCode === 404 || error.message?.includes('item-not-found')) {
      return null
    }
    throw error
  }
}

// Envio de mídia genérico
export async function sendMedia(sessionId: string, to: string, filePath: string, options: { caption?: string, mimetype?: string }) {
  const s = sessions.get(sessionId)
  if (!s?.sock) throw new Error('session_not_found')

  const jid = to.includes('@s.whatsapp.net') || to.includes('@g.us')
    ? to
    : `${to.replace(/\D/g, '')}@s.whatsapp.net`

  // Processar mídia primeiro para gerar thumbnails
  let mediaInfo: MediaInfo
  try {
    const mimetype = options.mimetype || require('mime-types').lookup(filePath) || 'application/octet-stream'
    mediaInfo = await processMedia(filePath, mimetype)
  } catch (error) {
    console.warn('[wa][send][media][process][warn]', error)
    throw new Error('media_processing_failed')
  }

  const buffer = fs.readFileSync(filePath)
  const mime = mediaInfo.mimetype

  let message: any = { caption: options.caption }
  if (mime.startsWith('image/')) message.image = buffer
  else if (mime.startsWith('video/')) message.video = buffer
  else if (mime.startsWith('audio/')) message.audio = buffer
  else if (mime === 'image/webp') message.sticker = buffer
  else message.document = buffer, message.mimetype = mime, message.fileName = path.basename(filePath)

  const result = await s.sock.sendMessage(jid, message)
  
  // Armazenar informações da mídia enviada
  if (result) {
    const msgId = result.key?.id
    if (msgId) {
      const msgObj = {
        id: msgId,
        from: s.sock.user?.id || sessionId,
        to: jid,
        text: options.caption || `📎 ${mediaInfo.filename}`,
        fromMe: true,
        timestamp: Date.now(),
        mediaType: mediaInfo.type,
        mediaPath: mediaInfo.originalPath,
        thumbnailPath: mediaInfo.thumbnailPath,
        previewPath: mediaInfo.previewPath,
        mediaInfo: {
          type: mediaInfo.type,
          mimetype: mediaInfo.mimetype,
          size: mediaInfo.size,
          width: mediaInfo.width,
          height: mediaInfo.height,
          duration: mediaInfo.duration,
          filename: mediaInfo.filename
        }
      }
      
      // Salvar no store local
      appendMessage(sessionId, msgObj)
      
      // Broadcast para clientes conectados
      try {
        broadcast(sessionId, 'message', msgObj)
      } catch (e) {
        console.warn('[wa][send][broadcast][warn]', e)
      }
    }
  }
  
  return result
}

// Novo: estado resumido da sessão
export function getStatus(sessionId: string) {
  // tenta global.sessoes se existir, depois fallback local
  const globalSessions: any = (global as any).sessions
  const s: Sess | undefined = globalSessions?.get?.(sessionId) ?? sessions.get(sessionId)
  const jid = (s as any)?.sock?.user?.id || null
  return { state: s?.lastState ?? 'unknown', hasQR: !!s?.qrDataUrl, jid }
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
  const baseDir = sess?.baseDir || path.join(SESS_DIR, sessionId)
  // Tentar logout/fechar socket caso exista
  try {
    if (sess?.sock) {
      try { await sess.sock.logout?.() } catch {}
      try { sess.sock.ws.close() } catch {}
    }
  } catch {}
  // Remover diretório de credenciais (mesmo se sessão não está em memória)
  try { nukeDir(baseDir) } catch {}
  // Preservar mensagens em memória opcionalmente
  const preservedMsgs = keepMessages ? (sess?.messages ? [...sess.messages] : []) : undefined
  sessions.delete(sessionId)
  if (keepMessages) {
    // Recria placeholder da sessão somente com mensagens preservadas (sem sock)
    sessions.set(sessionId, { baseDir, messages: preservedMsgs || [] })
  }
  // Opcional: refletir no banco status "closed"
  try {
    await supa.from('sessions').upsert(
      { session_id: sessionId, status: 'closed' },
      { onConflict: 'session_id' }
    )
  } catch {}
  return { ok: true, cleaned: true }
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
export function getSessionStatus(sessionId: string): { state: SessState; jid?: string | null } {
  const s = sessions.get(sessionId)
  const jid = (s as any)?.sock?.user?.id || null
  return { state: sessionState.get(sessionId) || 'closed', jid }
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

// 🤖 === CONTROLE DE IA ===
export function toggleAI(sessionId: string, enabled: boolean, userId?: string): { ok: boolean; aiEnabled: boolean; message: string } {
  const sess = sessions.get(sessionId)
  if (!sess) {
    return { ok: false, aiEnabled: false, message: 'Sessão não encontrada' }
  }
  
  const previousState = sess.aiEnabled !== false // Por padrão ativado
  sess.aiEnabled = enabled
  sess.aiToggledBy = userId || 'unknown'
  sess.aiToggledAt = Date.now()
  
  const action = enabled ? 'ativou' : 'desativou'
  const who = userId ? `usuário ${userId}` : 'sistema'
  console.log(`[wa][ai][toggle] ${who} ${action} IA para sessão ${sessionId}`)
  
  return { 
    ok: true, 
    aiEnabled: enabled,
    message: `IA ${enabled ? 'ativada' : 'desativada'} com sucesso`
  }
}

export function getAIStatus(sessionId: string): { 
  ok: boolean
  aiEnabled: boolean
  aiGlobalEnabled: boolean
  toggledBy?: string
  toggledAt?: number
  message: string
} {
  const sess = sessions.get(sessionId)
  const aiGlobalEnabled = process.env.AI_AUTO_REPLY !== '0'
  
  if (!sess) {
    return { 
      ok: false, 
      aiEnabled: false,
      aiGlobalEnabled,
      message: 'Sessão não encontrada' 
    }
  }
  
  const aiSessionEnabled = sess.aiEnabled !== false // Por padrão ativado
  
  return { 
    ok: true,
    aiEnabled: aiSessionEnabled && aiGlobalEnabled,
    aiGlobalEnabled,
    toggledBy: sess.aiToggledBy,
    toggledAt: sess.aiToggledAt,
    message: aiSessionEnabled && aiGlobalEnabled 
      ? 'IA ativa e funcionando'
      : !aiGlobalEnabled 
        ? 'IA desabilitada globalmente (AI_AUTO_REPLY=0)'
        : 'IA desabilitada para esta sessão (atendente assumiu)'
  }
}
