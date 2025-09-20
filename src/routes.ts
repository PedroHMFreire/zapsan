import { Router, Request, Response } from 'express'
// Update the import to match the actual exported member names from './wa'
import { createOrLoadSession, getQR, sendText, getStatus } from './wa'
// If 'createOrLoadSession' exists but is exported with a different name, import it accordingly:
// import { actualExportedName as createOrLoadSession, getQR, sendText } from './wa'

const r = Router()

// Saúde do serviço
r.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: process.uptime() })
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