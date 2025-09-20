import express from 'express'
import cors from 'cors'
import { setDefaultResultOrder } from 'dns'
import morgan from 'morgan'

// Importa o bootstrap do WhatsApp (arquivo que te enviei)
import {
  startSession,
  getSessionState,
  getSessionQR,
  sendText,
  destroySession,
} from './wa'

// Algumas redes quebram IPv6; priorizamos IPv4 para estabilidade do Baileys
try {
  setDefaultResultOrder('ipv4first')
} catch { /* Node <18 ignora */ }

const app = express()
app.use(cors())
app.use(express.json())
app.use(morgan('dev'))

// ---- Rotas WhatsApp ----

// Criar/Iniciar sessão (gera QR se não houver login salvo)
app.post('/api/sessions/create', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || 'default')
    await startSession(sessionId)
    res.json({ ok: true, sessionId })
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'fail' })
  }
})

// Obter QR e status atual
app.get('/api/sessions/:id/qr', async (req, res) => {
  try {
    const { id } = req.params
    const data = await getSessionQR(id)
    res.json(data) // { status: 'qr'|'online'|..., qr: dataURL|null }
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'fail' })
  }
})

// Health da sessão (útil para o Render Health Check)
app.get('/healthz/:id', (req, res) => {
  const s = getSessionState(req.params.id)
  res.json(s) // { sessionId, status, qr, lastCode }
})

// Enviar mensagem de texto
app.post('/api/sessions/:id/send', async (req, res) => {
  try {
    const { id } = req.params
    const { jid, text } = req.body || {}
    if (!jid || !text) return res.status(400).json({ ok: false, error: 'jid e text são obrigatórios' })
    await sendText(id, jid, text)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'fail' })
  }
})

// Destruir sessão (logout + apagar credenciais)
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params
    await destroySession(id)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'fail' })
  }
})

// Raiz simples
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'ZapModa API',
    endpoints: {
      create: 'POST /api/sessions/create { sessionId }',
      qr: 'GET /api/sessions/:id/qr',
      health: 'GET /healthz/:id',
      send: 'POST /api/sessions/:id/send { jid, text }',
      destroy: 'DELETE /api/sessions/:id',
    },
  })
})

// Sobe o servidor (Render usa PORT)
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API online na porta :${PORT}`)
})

export default app
