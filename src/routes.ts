import { Router, Request, Response } from 'express'
// Update the import to match the actual exported member names from './wa'
import { createOrLoadSession, getQR, sendText, getStatus, getDebug, getMessages as getMessagesNew, sendMedia, getAllSessionMeta, cleanLogout, createIdleSession, nukeAllSessions, getSessionStatus, onMessageStream, allowManualStart, getProfilePicture, toggleAI, getAIStatus } from './wa'
import { serveMedia } from './mediaProcessor'
import { authenticate, upsertUserIfMissing, findUser, createUser } from './users'
import { registerUser, loginUser, fetchUserProfile } from './supaUsers'
import { getUserProfile, createOrUpdateUserProfile, getUserKnowledge, updateUserKnowledge, createUserDataStructure } from './userProfiles'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { queryMessages } from './messageStore'
import { search } from './searchIndex'
import { sseHandler } from './realtime'
import { canCreateSession, takeSendToken, snapshotRateState } from './rateLimit'
import os from 'os'
// fs/path já importados acima
import { loadKnowledge, selectSections, updateKnowledge } from './knowledge'
import { getOrCreateUserSession } from './userSessions'
import { recordMessage, checkQuota, getUsage, getPlan } from './usage'
import { supa } from './db'
import bcrypt from 'bcrypt'
import { setUserSession, ensureSessionStarted } from './userSessions'
import { hasSupabaseEnv } from './supabase'
import { getPaginationConfig, getPerformanceConfig, getTimeoutConfig } from './middleware/adaptiveConfig'
import { batchHandler, registerCommonBatchHandlers } from './middleware/batchHandler'
import { lazyLoadMessages, lazyLoadContacts, lazyLoadSessions } from './middleware/lazyLoader'
import { performanceHandler, getCurrentMetrics, resetMetrics } from './middleware/performanceMonitor'
import { getPushApiRoutes } from './pushNotifications'

// === Simple JSON persistence helpers ===
const DATA_DIR = path.join(process.cwd(), 'data')
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')) as T } catch { return fallback }
}
function writeJson(file: string, value: any) {
  try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2), 'utf8') } catch {}
}

// === Domain types ===
interface Flow { id: string; name: string; nodes: any }
interface Schedule { id: string; session_id: string; to: string; text: string; when: string; status: 'pending' | 'sent' | 'failed' }
type TagsMap = Record<string, string>

// === In-memory stores (loaded at startup) ===
const flows: Flow[] = readJson<Flow[]>('flows.json', [])
const schedules: Schedule[] = readJson<Schedule[]>('schedules.json', [])
const tags: TagsMap = readJson<TagsMap>('tags.json', {})

// === Schedule dispatcher ===
function scheduleDispatch(s: Schedule) {
  const delay = new Date(s.when).getTime() - Date.now()
  if (delay <= 0) return // past; will be handled manually if desired
  setTimeout(async () => {
    try {
      const manual = process.env.MANUAL_PAIRING === '1'
      if(manual){
        const st = getStatus(s.session_id)
        if(st.state !== 'open') {
          s.status = 'failed'
        } else {
          await sendText(s.session_id, s.to, s.text)
          s.status = 'sent'
        }
      } else {
        await createOrLoadSession(s.session_id)
        await sendText(s.session_id, s.to, s.text)
        s.status = 'sent'
      }
    } catch {
      s.status = 'failed'
    } finally {
      writeJson('schedules.json', schedules)
    }
  }, delay)
}

// Re-arm pending schedules on startup
schedules.filter(s => s.status === 'pending').forEach(scheduleDispatch)
// If 'createOrLoadSession' exists but is exported with a different name, import it accordingly:
// import { actualExportedName as createOrLoadSession, getQR, sendText } from './wa'

const r = Router()

// Diagnóstico de ambiente de autenticação (não expõe chaves reais)
r.get('/debug/auth-env', (_req: Request, res: Response) => {
  const flags = {
    hasSupabaseEnv: hasSupabaseEnv(),
    SUPABASE_URL_SET: !!process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY_SET: !!process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY_SET: !!process.env.SUPABASE_SERVICE_ROLE_KEY
  }
  res.json(flags)
})

// Debug de configuração adaptativa
r.get('/debug/adaptive-config', (req: Request, res: Response) => {
  const deviceContext = req.deviceContext
  const adaptiveConfig = req.adaptiveConfig
  
  res.json({
    deviceContext,
    adaptiveConfig,
    timestamp: Date.now(),
    userAgent: req.headers['user-agent'],
    headers: {
      saveData: req.headers['save-data'],
      connection: req.headers.connection,
      rtt: req.headers.rtt,
      downlink: req.headers.downlink
    }
  })
})

// === Auth & sessão por usuário ===
// /auth/register: cria novo usuário; /auth/login: apenas autentica (sem auto-criação) ou aceita legacy { user }

// Novo registro baseado em email + password
r.post('/auth/register', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email||'').trim().toLowerCase()
    const name = req.body?.name ? String(req.body.name).trim() : ''
    const password = String(req.body?.password||'')
    if(!email || !password) return res.status(400).json({ error: 'missing_fields' })
    if(password.length < 6) return res.status(400).json({ error: 'weak_password' })
    const hash = await bcrypt.hash(password, 10)
    const { data, error } = await supa.from('users').upsert(
      { email, name: name || null, passwordHash: hash },
      { onConflict: 'email' }
    ).select('id, email, name').single()
    if(error){
      const msg = error.message || ''
      if(/duplicate|unique|23505/i.test(msg)) return res.status(409).json({ error: 'user_exists' })
      return res.status(500).json({ error: 'registration_failed', detail: msg })
    }
    if(!data) return res.status(500).json({ error: 'registration_failed' })
    const userId = data.id
    const sessionId = await getOrCreateUserSession(userId)
    createOrLoadSession(sessionId).catch(()=>{})
    res.cookie('uid', userId, { httpOnly: true, sameSite: 'lax', secure: false })
    return res.status(201).json({ ok:true, user: data, sessionId })
  } catch(err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Login baseado em email + password
r.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email||'').trim().toLowerCase()
    const password = String(req.body?.password||'')
    if(!email || !password) return res.status(400).json({ error: 'missing_credentials' })
    const { data: u, error } = await supa.from('users')
      .select('id, email, name, passwordHash')
      .eq('email', email)
      .single()
    if(error || !u || !u.passwordHash) return res.status(401).json({ error: 'invalid_credentials' })
    const ok = await bcrypt.compare(password, u.passwordHash)
    if(!ok) return res.status(401).json({ error: 'invalid_credentials' })
    const sessionId = await getOrCreateUserSession(u.id)
    createOrLoadSession(sessionId).catch(()=>{})
    res.cookie('uid', u.id, { httpOnly: true, sameSite: 'lax', secure: false })
    return res.json({ ok:true, user: { id: u.id, email: u.email, name: u.name }, sessionId, sessionBoot: true })
  } catch(err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Retorna a sessão do usuário logado (por cookie ou query user)
r.get('/me/session', async (req: Request, res: Response) => {
  try {
    const uid = (req.cookies?.uid) || String(req.query.user||'')
    if(!uid) return res.status(401).json({ error: 'unauthenticated' })
    const sessionId = await getOrCreateUserSession(uid)
    res.json({ userId: uid, sessionId })
  } catch (err:any){
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})
const upload = multer({ dest: path.join(process.cwd(), 'data', 'uploads') })

// Saúde do serviço
r.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: process.uptime() })
})

// Apaga todas as sessões (requer query confirm=1)
r.delete('/sessions', (req: Request, res: Response) => {
  if(String(req.query.confirm||'') !== '1'){
    return res.status(400).json({ error: 'confirmation_required', message: 'Use ?confirm=1 para confirmar exclusão de todas as sessões.' })
  }
  const out = nukeAllSessions() // já contém ok:true
  res.json({ ...out, wiped:true })
})

// Debug sessão
r.get('/sessions/:id/debug', (req: Request, res: Response) => {
  try {
    const info = getDebug(req.params.id)
    return res.json(info)
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Knowledge base endpoints
r.get('/knowledge', (_req: Request, res: Response) => {
  const k = loadKnowledge()
  res.json({ updatedAt: k.mtimeMs, content: k.raw })
})

r.put('/knowledge', (req: Request, res: Response) => {
  try {
    const content = String(req.body?.content || '')
    if (!content.trim()) return res.status(400).json({ error: 'empty_content' })
    updateKnowledge(content)
    const k = loadKnowledge()
    res.json({ ok: true, updatedAt: k.mtimeMs })
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

r.get('/knowledge/sections', (req: Request, res: Response) => {
  const q = String(req.query.q || '')
  const sections = selectSections(q)
  res.json({ sections: sections.map(s=>({ heading: s.heading, content: s.content, index: s.index, score: s.score })) })
})

// Criar/inicializar sessão
r.post('/sessions/create', async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.session_id || '').trim()
    if (!sessionId) {
      return res.status(400).json({ error: 'bad_request', message: 'session_id obrigatório' })
    }
    // throttle per IP & global
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
    const allowed = canCreateSession(ip)
    if(!allowed.ok){
      return res.status(429).json({ error: 'rate_limited', scope: allowed.reason })
    }
    // Nunca auto-gerar QR: criar sessão idle sempre
    createIdleSession(sessionId)
    return res.status(201).json({ ok:true, status: 'idle', manual: process.env.MANUAL_PAIRING === '1' })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Inicia pairing manualmente (gera socket e QR)
r.post('/sessions/:id/start', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const info = getDebug(id)
    if(!info.exists) createIdleSession(id)
    if(info.state && ['pairing','open'].includes(info.state)) return res.status(409).json({ error: 'already_active', state: info.state })
    // Autoriza start manual e inicia socket (vai gerar QR)
    allowManualStart(id)
    await createOrLoadSession(id)
    return res.json({ ok:true, started:true })
  } catch (err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Regenera QR (reinicia socket se necessário) respeitando grace
r.post('/sessions/:id/qr/regenerate', async (req: Request, res: Response) => {
  try {
    if(process.env.MANUAL_PAIRING !== '1') return res.status(400).json({ error: 'not_manual_mode' })
    const { id } = req.params
    const force = String(req.query.force||'') === '1'
    const dbg = getDebug(id)
    if(!dbg.exists) return res.status(404).json({ error: 'not_found' })
    if(dbg.state === 'open') return res.status(400).json({ error: 'already_open' })
    if(dbg.scanGraceRemaining && dbg.scanGraceRemaining > 0 && !force){
      return res.status(429).json({ error: 'grace_active', remaining: dbg.scanGraceRemaining })
    }
    // reinicia para forçar novo QR
  await createOrLoadSession(id)
    return res.json({ ok:true, regenerating:true })
  } catch (err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Buscar QR (quando disponível)
r.get('/sessions/:id/qr', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id
    const qr = getQR(sessionId)
    if (!qr) return res.status(404).json({ error: 'not_ready' })
    return res.json({ dataUrl: qr })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Upsert básico de usuário por email (unique). Body: { email, name? }
r.post('/users', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email||'').trim().toLowerCase()
    const name = req.body?.name ? String(req.body.name).trim() : null
    if(!email) return res.status(400).json({ error: 'bad_request', message: 'email obrigatório' })
    const { data, error } = await supa.from('users').upsert(
      { email, name },
      { onConflict: 'email' }
    ).select('id, email, name').single()
    if(error){
      const msg = error.message || ''
      if(/duplicate|unique|23505/i.test(msg)){
        const { data: existing } = await supa.from('users').select('id, email, name').eq('email', email).single()
        return res.json({ ok:true, user: existing })
      }
      return res.status(500).json({ error: 'internal_error', detail: msg })
    }
    return res.status(201).json({ ok:true, user: data })
  } catch(err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Vincula uma sessão existente (sessionId lógico) a um usuário
r.post('/users/:id/bind-session', async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.id)
    const { session_id } = req.body || {}
    if(!session_id) return res.status(400).json({ error: 'bad_request', message: 'session_id obrigatório' })
    await setUserSession(userId, String(session_id))
    return res.json({ ok:true })
  } catch(err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Garante que a sessão (Baileys) do usuário exista e esteja inicializando em background
r.post('/users/:id/ensure-session', async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.id)
    const { sessionId } = await ensureSessionStarted(userId)
    return res.json({ ok:true, session_id: sessionId })
  } catch(err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Lista sessões associadas a um usuário (id do model User, não sessionId lógico)
r.get('/users/:id/sessions', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    if(!id) return res.status(400).json({ error: 'missing_id' })
    const { data, error } = await supa.from('sessions')
      .select('*')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
    if(error) return res.status(500).json({ error: 'internal_error', detail: error.message })
    res.json({ sessions: data || [] })
  } catch(err:any){
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Mensagens persistidas no Postgres (paginação por cursor temporal decrescente)
// Query params: limit (adaptativo), before (timestamp ISO ou epoch ms) para paginação
r.get('/sessions/:id/messages/db', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    
    // Usar configuração adaptativa
    const paginationConfig = getPaginationConfig(req)
    const limitRaw = Number(req.query.limit || paginationConfig.defaultLimit)
    const limit = isNaN(limitRaw) ? paginationConfig.defaultLimit : 
                  Math.min(Math.max(limitRaw, 1), paginationConfig.maxLimit)
    
    const beforeRaw = String(req.query.before||'').trim()
    let beforeDate: Date | undefined
    if(beforeRaw){
      const asNum = Number(beforeRaw)
      if(!isNaN(asNum) && asNum > 0){
        beforeDate = new Date(asNum)
      } else {
        const d = new Date(beforeRaw)
        if(!isNaN(d.getTime())) beforeDate = d
      }
    }
    
    // Busca mensagens direto por session_key
    let query = supa.from('messages')
      .select('*')
      .eq('session_key', id)
      .order('timestamp', { ascending: false })
      .limit(limit)
    if(beforeDate){
      query = query.lt('timestamp', beforeDate.toISOString())
    }
    const { data, error } = await query
    if(error) return res.status(500).json({ error: 'internal_error', detail: error.message })
    
    let nextCursor: string | null = null
    if(data && data.length === limit){
      const last = data[data.length - 1]
      if(last?.timestamp) nextCursor = last.timestamp
    }
    
    // Headers informativos sobre adaptação
    res.set('X-Adaptive-Limit', limit.toString())
    res.set('X-Max-Limit', paginationConfig.maxLimit.toString())
    
    res.json({ 
      messages: data||[], 
      nextCursor, 
      pageSize: data?.length||0,
      adaptive: {
        appliedLimit: limit,
        maxLimit: paginationConfig.maxLimit,
        deviceOptimized: true
      }
    })
  } catch(err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Lista contatos de uma sessão persistidos
r.get('/sessions/:id/contacts', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { data, error } = await supa.from('contacts')
      .select('*')
      .eq('session_key', id)
      .order('name', { ascending: true })
      .order('jid', { ascending: true })
    if(error) return res.status(500).json({ error: 'internal_error', detail: error.message })
    res.json({ contacts: data||[] })
  } catch(err:any){
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Enviar texto via WhatsApp
r.post('/messages/send', async (req: Request, res: Response) => {
  console.log('[messages/send] Headers:', req.headers.cookie)
  console.log('[messages/send] Body:', req.body)
  
  try {
    const { to, text } = req.body || {}
    const userId = (req.cookies?.uid) || String(req.body?.user||'')
    console.log('[messages/send] userId extraído:', userId)
    
    if(!userId) return res.status(401).json({ error: 'unauthenticated' })
    if (!to || !text) {
      return res.status(400).json({ error: 'bad_request', message: 'to e text são obrigatórios' })
    }
  const session_id = await getOrCreateUserSession(userId)
  console.log('[messages/send] session_id:', session_id)
  
    const quota = checkQuota(userId, session_id)
    if(!quota.ok){
      return res.status(429).json({ error: 'quota_exceeded', remaining: 0, plan: quota.plan })
    }
    const token = takeSendToken(String(session_id))
    if(!token.ok){
      return res.status(429).json({ error: 'rate_limited', message: 'Limite de envio atingido. Aguarde.', remaining: token.remaining })
    }
    const manual = process.env.MANUAL_PAIRING === '1'
    if(manual){
      const st = getStatus(String(session_id))
      if(st.state !== 'open'){ return res.status(409).json({ error: 'not_open', state: st.state }) }
    } else {
      await createOrLoadSession(String(session_id))
    }
    
    console.log('[messages/send] Chamando sendText...')
    await sendText(String(session_id), String(to), String(text))
    recordMessage(session_id)
    return res.json({ ok: true })
  } catch (err: any) {
    const code = err?.message === 'session_not_found' ? 404 : 500
    return res.status(code).json({ error: err?.message || 'internal_error' })
  }
})

// === Perfil & sessão do usuário ===
r.get('/me', async (req: Request, res: Response) => {
  const uid = (req.cookies?.uid) || ''
  if(!uid) return res.status(401).json({ error: 'unauthenticated' })
  const sessionId = await getOrCreateUserSession(uid)
  res.json({ userId: uid, sessionId })
})

r.get('/me/profile', async (req: Request, res: Response) => {
  try {
    const sessionQuery = String(req.query.session_id||'').trim()
    if(sessionQuery){
      // Perfil baseado em session_id direto
      const { data: s, error: sErr } = await supa.from('sessions')
        .select('*')
        .eq('session_id', sessionQuery)
        .single()
      if(sErr || !s) return res.status(404).json({ error: 'not_found' })
      let userData: any = null
      if(s.user_id){
        const { data: usr } = await supa.from('users').select('id, email, name').eq('id', s.user_id).single()
        if(usr) userData = usr
      }
      return res.json({ sessionId: s.session_id, status: s.status, user: userData })
    }
    // Fluxo anterior (cookie uid)
    const uid = (req.cookies?.uid) || ''
    if(!uid) return res.status(401).json({ error: 'unauthenticated' })
    const sessionId = await getOrCreateUserSession(uid)
    const usage = getUsage(sessionId)
    const status = getSessionStatus(sessionId)
    let name: string | undefined
    let plan: string | undefined
    try {
      const prof = await fetchUserProfile(uid)
      if(prof){ name = prof.name; plan = (prof.plan as string) || undefined }
    } catch {}
    if(!plan){
      const p = getPlan(uid)
      plan = p?.name || 'Free'
    }
    return res.json({ userId: uid, sessionId, name, plan, usage, session: status })
  } catch(err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

r.post('/me/logout', (req: Request, res: Response) => {
  res.clearCookie('uid')
  try { localStorageClearHint(res) } catch {}
  res.json({ ok:true })
})

// Proxy de QR da sessão do usuário
r.get('/me/session/qr', async (req: Request, res: Response) => {
  const uid = (req.cookies?.uid) || ''
  if(!uid) return res.status(401).json({ error: 'unauthenticated' })
  const sessionId = await getOrCreateUserSession(uid)
  const qr = getQR(sessionId)
  if(!qr) return res.status(404).json({ error: 'not_ready' })
  res.json({ dataUrl: qr })
})

r.post('/me/session/regen-qr', async (req: Request, res: Response) => {
  if(process.env.MANUAL_PAIRING !== '1') return res.status(400).json({ error: 'not_manual_mode' })
  const uid = (req.cookies?.uid) || ''
  if(!uid) return res.status(401).json({ error: 'unauthenticated' })
  const sessionId = await getOrCreateUserSession(uid)

// 🤖 === ROTAS DE CONTROLE DA IA ===

// Toggle IA para sessão específica
r.post('/sessions/:id/ai/toggle', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id
    const { enabled } = req.body
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'bad_request', message: 'Campo "enabled" deve ser true ou false' })
    }
    
    const result = toggleAI(sessionId, enabled, req.body.userId)
    
    if (!result.ok) {
      return res.status(404).json({ error: 'session_not_found', message: result.message })
    }
    
    return res.json(result)
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Status da IA para sessão específica
r.get('/sessions/:id/ai/status', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id
    const result = getAIStatus(sessionId)
    
    if (!result.ok) {
      return res.status(404).json({ error: 'session_not_found', message: result.message })
    }
    
    return res.json(result)
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Toggle IA para a sessão do usuário logado
r.post('/me/session/ai/toggle', async (req: Request, res: Response) => {
  try {
    const uid = (req.cookies?.uid) || ''
    if (!uid) return res.status(401).json({ error: 'unauthenticated' })
    
    const sessionId = await getOrCreateUserSession(uid)
    const { enabled } = req.body
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'bad_request', message: 'Campo "enabled" deve ser true ou false' })
    }
    
    const result = toggleAI(sessionId, enabled, uid)
    return res.json(result)
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Status da IA para a sessão do usuário logado
r.get('/me/session/ai/status', async (req: Request, res: Response) => {
  try {
    const uid = (req.cookies?.uid) || ''
    if (!uid) return res.status(401).json({ error: 'unauthenticated' })
    
    const sessionId = await getOrCreateUserSession(uid)
    const result = getAIStatus(sessionId)
    return res.json(result)
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// 👤 === ROTAS DE PERFIL DE USUÁRIO ===

// Get user profile
r.get('/me/profile', async (req: Request, res: Response) => {
  try {
    const uid = (req.cookies?.uid) || ''
    if (!uid) return res.status(401).json({ error: 'unauthenticated' })
    
    const profile = await getUserProfile(uid)
    return res.json({ profile })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Update user profile
r.post('/me/profile', async (req: Request, res: Response) => {
  try {
    const uid = (req.cookies?.uid) || ''
    if (!uid) return res.status(401).json({ error: 'unauthenticated' })
    
    const { botName, businessName, botTone, products, rules, memory } = req.body
    
    const profile = await createOrUpdateUserProfile(uid, {
      botName,
      businessName, 
      botTone,
      products: Array.isArray(products) ? products : [],
      rules: Array.isArray(rules) ? rules : [],
      memory: Array.isArray(memory) ? memory : []
    })
    
    return res.json({ profile })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Get user knowledge base
r.get('/me/knowledge', async (req: Request, res: Response) => {
  try {
    const uid = (req.cookies?.uid) || ''
    if (!uid) return res.status(401).json({ error: 'unauthenticated' })
    
    const knowledge = await getUserKnowledge(uid)
    return res.json({ knowledge })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Update user knowledge base
r.post('/me/knowledge', async (req: Request, res: Response) => {
  try {
    const uid = (req.cookies?.uid) || ''
    if (!uid) return res.status(401).json({ error: 'unauthenticated' })
    
    const { sections } = req.body
    
    if (!Array.isArray(sections)) {
      return res.status(400).json({ error: 'bad_request', message: 'sections deve ser um array' })
    }
    
    const validSections = sections.filter(s => 
      typeof s === 'object' && 
      typeof s.title === 'string' && 
      typeof s.content === 'string'
    )
    
    if (validSections.length !== sections.length) {
      return res.status(400).json({ error: 'bad_request', message: 'Todas as seções devem ter title e content' })
    }
    
    const knowledge = await updateUserKnowledge(uid, validSections)
    return res.json({ knowledge })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Initialize user data structure (for new users)
r.post('/me/init', async (req: Request, res: Response) => {
  try {
    const uid = (req.cookies?.uid) || ''
    if (!uid) return res.status(401).json({ error: 'unauthenticated' })
    
    await createUserDataStructure(uid)
    
    // Create default profile if doesn't exist
    const existingProfile = await getUserProfile(uid)
    if (!existingProfile) {
      await createOrUpdateUserProfile(uid, {
        botName: 'Meu Atendente',
        businessName: 'Minha Empresa',
        botTone: 'Vendedor consultivo e simpático',
        products: ['Produto 1', 'Produto 2'],
        rules: ['Seja prestativo e claro', 'Pergunte preferências do cliente'],
        memory: ['Informação importante sobre o negócio']
      })
    }
    
    return res.json({ ok: true, message: 'Dados do usuário inicializados' })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})
  try { await createOrLoadSession(sessionId) } catch {}
  res.json({ ok:true, regenerating:true })
})

r.post('/me/session/clean', async (req: Request, res: Response) => {
  const uid = (req.cookies?.uid) || ''
  if(!uid) return res.status(401).json({ error: 'unauthenticated' })
  const sessionId = await getOrCreateUserSession(uid)
  await cleanLogout(sessionId, { keepMessages: true })
  res.json({ ok:true, cleaned:true })
})

// Buscar contatos salvos da sessão do usuário
r.get('/me/contacts', async (req: Request, res: Response) => {
  const uid = (req.cookies?.uid) || ''
  if(!uid) return res.status(401).json({ error: 'unauthenticated' })
  
  try {
    const sessionId = await getOrCreateUserSession(uid)
    const { data: contacts, error } = await supa
      .from('contacts')
      .select('jid, name, is_group')
      .eq('session_key', sessionId)
      .order('name')
    
    if(error) {
      console.warn('[contacts][fetch][error]', error.message)
      return res.status(500).json({ error: 'database_error' })
    }
    
    res.json({ contacts: contacts || [] })
  } catch (err: any) {
    console.warn('[contacts][fetch][catch]', err?.message)
    res.status(500).json({ error: 'internal_error' })
  }
})

// Deletar contato específico da sessão do usuário
r.delete('/me/contacts/:jid', async (req: Request, res: Response) => {
  const uid = (req.cookies?.uid) || ''
  if(!uid) return res.status(401).json({ error: 'unauthenticated' })
  
  try {
    const sessionId = await getOrCreateUserSession(uid)
    const jid = decodeURIComponent(req.params.jid)
    
    const { error } = await supa
      .from('contacts')
      .delete()
      .eq('session_key', sessionId)
      .eq('jid', jid)
    
    if(error) {
      console.warn('[contacts][delete][error]', error.message)
      return res.status(500).json({ error: 'database_error' })
    }
    
    res.json({ ok: true, deleted_jid: jid })
  } catch (err: any) {
    console.warn('[contacts][delete][catch]', err?.message)
    res.status(500).json({ error: 'internal_error' })
  }
})

// Buscar foto de perfil de um contato
r.get('/contacts/:jid/photo', async (req: Request, res: Response) => {
  const uid = (req.cookies?.uid) || ''
  if(!uid) return res.status(401).json({ error: 'unauthenticated' })
  
  try {
    const sessionId = await getOrCreateUserSession(uid)
    const jid = decodeURIComponent(req.params.jid)
    const type = req.query.type === 'image' ? 'image' : 'preview' // high or low res
    
    console.log(`Fetching profile picture for ${jid} (${type})`)
    
    const status = getSessionStatus(sessionId)
    if (status.state !== 'open') {
      return res.status(400).json({
        error: 'whatsapp_not_connected',
        message: 'WhatsApp session not connected'
      })
    }

    try {
      const profileUrl = await getProfilePicture(sessionId, jid, type)
      
      res.json({
        success: true,
        profileUrl
      })
    } catch (error: any) {
      console.warn('[photo][fetch][error]', error.message)
      res.status(500).json({
        error: 'fetch_error',
        message: error.message
      })
    }
  } catch (err: any) {
    console.warn('[photo][fetch][catch]', err?.message)
    res.status(500).json({ error: 'internal_error' })
  }
})

function localStorageClearHint(res: Response){
  // placeholder: em ambientes reais podemos instruir o frontend a limpar storage
  res.setHeader('X-Client-Clear-Storage','1')
}

// Enviar mídia via upload multipart
r.post('/messages/media', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const { session_id, to, caption } = req.body || {}
    if (!session_id || !to || !req.file) return res.status(400).json({ error: 'bad_request', message: 'session_id, to e file são obrigatórios' })
    const token = takeSendToken(String(session_id))
    if(!token.ok){
      return res.status(429).json({ error: 'rate_limited', message: 'Limite de envio atingido. Aguarde.', remaining: token.remaining })
    }
    const manual = process.env.MANUAL_PAIRING === '1'
    if(manual){
      const st = getStatus(String(session_id))
      if(st.state !== 'open'){ return res.status(409).json({ error: 'not_open', state: st.state }) }
    } else {
      await createOrLoadSession(String(session_id))
    }
    await sendMedia(String(session_id), String(to), req.file.path, { caption })
    return res.json({ ok: true })
  } catch (err: any) {
    const code = err?.message === 'session_not_found' ? 404 : 500
    return res.status(code).json({ error: err?.message || 'internal_error' })
  } finally {
    // Limpar arquivo temporário
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path) } catch {}
    }
  }
})

// Servir thumbnails de mídia
r.get('/media/thumbnail/:hash', (req: Request, res: Response) => {
  const hash = req.params.hash
  const thumbnailPath = path.join(process.cwd(), 'data', 'media', 'thumbnails', hash)
  serveMedia(thumbnailPath, res)
})

// Servir previews de mídia
r.get('/media/preview/:hash', (req: Request, res: Response) => {
  const hash = req.params.hash
  const previewPath = path.join(process.cwd(), 'data', 'media', 'previews', hash)
  serveMedia(previewPath, res)
})

// Servir mídia original
r.get('/media/original/:sessionId/:messageId', async (req: Request, res: Response) => {
  try {
    const { sessionId, messageId } = req.params
    
    // Verificar autenticação (implementar se necessário)
    // const uid = await verifyUser(req)
    // if (!uid) return res.status(401).json({ error: 'unauthenticated' })
    
    // Buscar mensagem no store para obter caminho da mídia
    const messages = getMessagesNew(sessionId, 1000)
    const message = messages.find(m => m.id === messageId)
    
    if (!message || !(message as any).mediaPath) {
      return res.status(404).json({ error: 'media_not_found' })
    }
    
    serveMedia((message as any).mediaPath, res)
  } catch (err: any) {
    console.warn('[media][original][serve][error]', err?.message)
    res.status(500).json({ error: 'serve_error' })
  }
})

// Status da sessão
r.get('/sessions/:id/status', (req: Request, res: Response) => {
  try {
    const { id } = req.params
    return res.json(getSessionStatus(id))
  } catch (err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Metrics endpoint (JSON)
r.get('/metrics', (_req: Request, res: Response) => {
  try {
    const meta = getAllSessionMeta()
    const rates = snapshotRateState()
    res.json({ time: Date.now(), host: os.hostname(), sessions: meta, rates })
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Força reset da sessão (apaga diretório de credenciais) e reinicia -> novo QR
r.post('/sessions/:id/reset', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const sessDirRoot = process.env.SESS_DIR || path.resolve(process.cwd(), 'sessions')
    const baseDir = path.join(sessDirRoot, id)
    // apagar diretório se existir
    try { fs.rmSync(baseDir, { recursive: true, force: true }) } catch {}
    // pequena espera opcional para garantir flush
    await new Promise(r=>setTimeout(r, 50))
    createOrLoadSession(id).catch(()=>{})
    res.json({ ok:true, resetting:true })
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Limpa sessão (logout e remove credenciais). Se keep=1 preserva mensagens em memória
r.post('/sessions/:id/clean', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const keep = String(req.query.keep||'') === '1'
    await cleanLogout(id, { keepMessages: keep })
    res.json({ ok: true, cleaned: true, keptMessages: keep })
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Mensagens recentes com filtros (adaptativo)
r.get('/sessions/:id/messages', (req: Request, res: Response) => {
  try {
    const { id } = req.params
    
    // Usar configuração adaptativa para mensagens
    const paginationConfig = getPaginationConfig(req)
    const limitRaw = Number(req.query.limit || paginationConfig.messageLimit)
    const limit = isNaN(limitRaw) ? paginationConfig.messageLimit : 
                  Math.min(Math.max(limitRaw, 1), paginationConfig.maxLimit)
    
    // Novo buffer já retorna ordenado por timestamp asc (assumido). Caso contrário ordenar aqui.
    const msgs = getMessagesNew(id, limit)
    
    // Headers informativos
    res.set('X-Adaptive-Message-Limit', limit.toString())
    
    return res.json({ 
      messages: msgs,
      adaptive: {
        appliedLimit: limit,
        messageLimit: paginationConfig.messageLimit,
        deviceOptimized: true
      }
    })
  } catch (err:any){
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Busca textual (índice invertido em memória; sessão usada apenas para validar existência futura)
r.get('/sessions/:id/search', (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.status(400).json({ error: 'empty_query' })
    const limit = Number(req.query.limit || 20)
    const results = search(q, isNaN(limit) ? 20 : limit)
    return res.json({ results })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// SSE stream em tempo real (com timeouts adaptativos)
r.get('/sessions/:id/stream', (req: Request, res: Response) => {
  const { id } = req.params
  
  // Configuração adaptativa de timeout
  const timeoutConfig = getTimeoutConfig(req)
  const sseTimeout = timeoutConfig.sseTimeout
  
  // Configuração de cabeçalhos SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-SSE-Timeout': sseTimeout.toString()
  })
  res.write(':ok\n\n')
  
  // Timeout adaptativo para limpeza da conexão
  const timeoutHandle = setTimeout(() => {
    if (!closed) {
      res.write(`event: timeout\n`)
      res.write(`data: {"reason":"adaptive_timeout","timeout":${sseTimeout}}\n\n`)
      res.end()
      closed = true
    }
  }, sseTimeout)
  
  // Envia estado inicial
  try {
    const state = getSessionStatus(id)
    res.write(`event: status\n`)
    res.write(`data: ${JSON.stringify(state)}\n\n`)
    
    // Usar limite adaptativo para mensagens recentes
    const paginationConfig = getPaginationConfig(req)
    const recent = getMessagesNew(id, paginationConfig.messageLimit)
    res.write(`event: recent\n`)
    res.write(`data: ${JSON.stringify(recent)}\n\n`)
  } catch {}
  let closed = false
  const unsub = onMessageStream(id, (m) => {
    if (closed) return
    try {
      // Envia mensagem achatada para compatibilidade com front antigo (chat.html) que faz JSON.parse(ev.data) direto.
      // Mantemos um campo type para futuras distinções, mas colocamos os atributos no nível raiz.
      const payload = { type: 'message', ...m }
      res.write(`event: message\n`)
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {}
  })
  
  // Cleanup na desconexão
  req.on('close', () => { 
    closed = true
    clearTimeout(timeoutHandle)
    try { unsub() } catch {} 
  })
})

// === Flows CRUD ===
r.get('/flows', (_req: Request, res: Response) => {
  res.json({ flows })
})

r.post('/flows', (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim() || 'Fluxo'
    const nodes = req.body?.nodes ?? []
    const flow: Flow = { id: Date.now().toString(36), name, nodes }
    flows.push(flow)
    writeJson('flows.json', flows)
    res.status(201).json({ ok: true, flow })
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

r.delete('/flows/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const idx = flows.findIndex(f => f.id === id)
  if (idx === -1) return res.status(404).json({ error: 'not_found' })
  flows.splice(idx, 1)
  writeJson('flows.json', flows)
  res.json({ ok: true })
})

// === Schedules ===
r.get('/schedules', (_req: Request, res: Response) => {
  res.json({ schedules })
})

r.post('/schedules', async (req: Request, res: Response) => {
  try {
    const { session_id, to, text, when } = req.body || {}
    if (!session_id || !to || !text || !when) return res.status(400).json({ error: 'bad_request' })
    const iso = new Date(when).toISOString()
    const sched: Schedule = { id: Date.now().toString(36), session_id: String(session_id), to: String(to), text: String(text), when: iso, status: 'pending' }
    schedules.push(sched)
    writeJson('schedules.json', schedules)
    scheduleDispatch(sched)
    res.status(201).json({ ok: true, schedule: sched })
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

r.delete('/schedules/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const idx = schedules.findIndex(s => s.id === id)
  if (idx === -1) return res.status(404).json({ error: 'not_found' })
  schedules.splice(idx, 1)
  writeJson('schedules.json', schedules)
  res.json({ ok: true })
})

// === Tags ===
r.get('/tags', (_req: Request, res: Response) => {
  res.json({ tags })
})

r.post('/tags', (req: Request, res: Response) => {
  try {
    const { message_id, label } = req.body || {}
    if (!message_id || !label) return res.status(400).json({ error: 'bad_request' })
    tags[String(message_id)] = String(label)
    writeJson('tags.json', tags)
    res.status(201).json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

r.delete('/tags/:id', (req: Request, res: Response) => {
  const { id } = req.params
  if (!tags[id]) return res.status(404).json({ error: 'not_found' })
  delete tags[id]
  writeJson('tags.json', tags)
  res.json({ ok: true })
})

// === Debug: lista rotas disponíveis (somente em dev) ===
r.get('/debug/routes', (_req: Request, res: Response) => {
  const stack: any[] = (r as any).stack || []
  const routes = stack
    .filter(l => l.route && l.route.path)
    .map(l => ({ path: l.route.path, methods: Object.keys(l.route.methods) }))
  res.json({ routes })
})

// ===== FASE 3: APIs OTIMIZADAS (BATCHING, LAZY LOADING, PERFORMANCE) =====

// Inicializar handlers de batch
registerCommonBatchHandlers()

// Endpoint de batching - múltiplas operações em uma requisição
r.post('/batch', batchHandler)

// Endpoints de lazy loading com metadados
r.get('/lazy/messages/:sessionId?', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId || 'default'
  const handler = lazyLoadMessages(sessionId)
  handler(req, res)
})

r.get('/lazy/contacts', lazyLoadContacts())
r.get('/lazy/sessions', lazyLoadSessions())

// Dashboard de performance e métricas
r.get('/performance', performanceHandler)
r.get('/performance/metrics', (_req: Request, res: Response) => {
  res.json(getCurrentMetrics())
})

// Reset de métricas (útil para testes)
r.post('/performance/reset', (_req: Request, res: Response) => {
  resetMetrics()
  res.json({ ok: true, message: 'Metrics reset successfully' })
})

// Exemplo de uso do batch - endpoint para demonstração
r.get('/batch/example', (_req: Request, res: Response) => {
  res.json({
    description: 'Exemplo de uso do endpoint de batching',
    usage: {
      method: 'POST',
      url: '/api/batch',
      body: {
        requests: [
          {
            id: 'status_check',
            method: 'GET',
            endpoint: 'sessions/default/status',
            params: {}
          },
          {
            id: 'get_contacts',
            method: 'GET', 
            endpoint: 'me/contacts',
            params: { limit: 10 }
          },
          {
            id: 'get_messages',
            method: 'GET',
            endpoint: 'sessions/default/messages',
            params: { limit: 5 }
          }
        ]
      }
    },
    advantages: [
      'Reduz número de requisições HTTP',
      'Otimizado para dispositivos móveis',
      'Processamento em batch eficiente',
      'Métricas de performance incluídas'
    ]
  })
})

// === Push Notifications API ===
const pushRoutes = getPushApiRoutes()

r.get('/api/push/config', pushRoutes.getConfig)
r.post('/api/push/subscribe', pushRoutes.subscribe)  
r.post('/api/push/unsubscribe', pushRoutes.unsubscribe)
r.post('/api/push/send', pushRoutes.sendNotification)
r.get('/api/push/stats', pushRoutes.getStats)

// Endpoint para sincronizar subscrições
r.post('/api/push/sync', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, message: 'Subscrição sincronizada' })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro interno' })
  }
})

export default r