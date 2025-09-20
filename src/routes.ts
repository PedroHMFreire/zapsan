import { Router, Request, Response } from 'express'
import {
  startSession,
  getSessionState,
  getSessionQR,
  sendText,
  destroySession,
} from './wa'

const r = Router()

// Saúde geral do serviço
r.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: process.uptime() })
})

// Health por sessão (útil para monitorar status específico)
r.get('/sessions/:id/health', (req: Request, res: Response) => {
  const s = getSessionState(String(req.params.id || 'default'))
  res.json(s) // { sessionId, status, qr, lastCode }
})

// Criar/Iniciar sessão (gera QR se necessário)
r.post('/sessions/create', async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.session_id || '').trim() || 'default'
    await startSession(sessionId)
    // Mantemos sua resposta simples e compatível
    return res.status(200).json({ ok: true, sessionId })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Buscar QR (e status). Se já estiver online, qr vem null.
r.get('/sessions/:id/qr', async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.params.id || 'default')
    const { status, qr } = await getSessionQR(sessionId)
    return res.json({ status, dataUrl: qr })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

// Enviar texto via WhatsApp
r.post('/messages/send', async (req: Request, res: Response) => {
  try {
    const { session_id, to, text } = req.body || {}
    if (!to || !text) {
      return res.status(400).json({ error: 'bad_request', message: 'to e text são obrigatórios' })
    }
    const sessionId = String(session_id || 'default')
    // garante sessão inicializada (não bloqueia se já existir)
    await startSession(sessionId)
    await sendText(sessionId, String(to), String(text))
    return res.json({ ok: true })
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'internal_error' })
  }
})

// Destruir sessão (logout + apagar credenciais)
r.delete('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.params.id || 'default')
    await destroySession(sessionId)
    return res.json({ ok: true })
  } catch (err: any) {
    return res.status(500).json({ error: 'internal_error', message: err?.message })
  }
})

export default r
