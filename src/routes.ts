import { Router, Request, Response } from 'express'
// Update the import to match the actual exported member names from './wa'
import { createOrLoadSession, getQR, sendText, getStatus } from './wa'
import fs from 'fs'
import path from 'path'
import { loadKnowledge, selectSections, updateKnowledge } from './knowledge'

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
      await createOrLoadSession(s.session_id)
      await sendText(s.session_id, s.to, s.text)
      s.status = 'sent'
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

// Saúde do serviço
r.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: process.uptime() })
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
    // dispara criação sem bloquear resposta
    createOrLoadSession(sessionId).catch(() => {})
    return res.status(202).json({ ok: true, status: 'creating' })
  } catch (err: any) {
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

// Enviar texto via WhatsApp
r.post('/messages/send', async (req: Request, res: Response) => {
  try {
    const { session_id, to, text } = req.body || {}
    if (!session_id || !to || !text) {
      return res.status(400).json({ error: 'bad_request', message: 'session_id, to e text são obrigatórios' })
    }
    await createOrLoadSession(String(session_id))
    await sendText(String(session_id), String(to), String(text))
    return res.json({ ok: true })
  } catch (err: any) {
    const code = err?.message === 'session_not_found' ? 404 : 500
    return res.status(code).json({ error: err?.message || 'internal_error' })
  }
})

// Status da sessão
r.get('/sessions/:id/status', (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const status = getStatus(id)
    return res.json(status)
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

export default r

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