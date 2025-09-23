import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import path from 'path'
import { setDefaultResultOrder } from 'dns'
import { logger } from './logger'
import routes from './routes'

// Força resolução IPv4 primeiro – mitiga quedas (ex.: stream errored 515) ligadas a IPv6/DNS em alguns ISPs macOS
setDefaultResultOrder('ipv4first')

// __dirname já existe em CommonJS; remoção de import.meta para evitar erro de compilação

const app = express()

// Captura falhas não tratadas cedo para evitar saída silenciosa em produção (Render, etc.)
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled Rejection')
})
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception')
})

// Middlewares básicos
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

// Frontend estático (sem bundler) - servimos depois dos redirects básicos
const pub = path.join(process.cwd(), 'public')

// Redireciona sempre para /login.html se não autenticado (cookie uid ausente) quando acessa raiz ou páginas principais
app.get(['/', '/index.html'], (req, res, next) => {
  try {
    const uid = req.cookies?.uid
    if(!uid){
      return res.redirect(302, '/login.html')
    }
    // autenticado: segue fluxo normal (servir index via estático)
    return res.sendFile(path.join(pub, 'index.html'))
  } catch {
    return res.redirect(302, '/login.html')
  }
})

// Se já autenticado e abrir /login.html manualmente, redireciona para /
app.get('/login.html', (req, res, next) => {
  const uid = req.cookies?.uid
  if(uid){
    return res.redirect(302, '/')
  }
  return res.sendFile(path.join(pub, 'login.html'))
})

app.use(express.static(pub))

// Rotas da API
app.use('/', routes)

// Health extra rápido (opcional; já existe em routes)
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }))

// 404 para API
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/sessions') || req.path.startsWith('/messages')) {
    return res.status(404).json({ error: 'not_found' })
  }
  next()
})

// Erros padrão em JSON
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled error')
  res.status(500).json({ error: 'internal_error' })
})

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => {
  logger.info(`ZapSan online em http://localhost:${PORT}`)
})
