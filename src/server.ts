import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
const compression = require('compression')
import path from 'path'
import { setDefaultResultOrder } from 'dns'
import { logger } from './logger'
import { responseLimiter } from './middleware/responseLimiter'
import { jsonOptimizer } from './middleware/jsonOptimizer'
import { apiCache } from './middleware/apiCache'
import { deviceDetector } from './middleware/deviceDetector'
import { adaptiveConfig } from './middleware/adaptiveConfig'
import { performanceMonitor, autoOptimizeMiddleware } from './middleware/performanceMonitor'
import { startMetaCacheCleaner } from './middleware/lazyLoader'
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
app.use(compression({
  filter: (req: express.Request, res: express.Response) => {
    if (req.headers['x-no-compression']) return false
    return compression.filter(req, res)
  },
  threshold: 1024, // Apenas arquivos > 1KB
  level: 6 // Balanceio compressão/CPU
}))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(cookieParser())

// Performance monitoring (métricas em tempo real)
app.use(performanceMonitor())

// Sistema adaptativo (detecta dispositivo e configura dinamicamente)
app.use(deviceDetector)
app.use(adaptiveConfig)

// Auto-otimização baseada em performance (Fase 3)
app.use(autoOptimizeMiddleware())

// Middleware de limite de resposta (protege dispositivos móveis)
app.use(responseLimiter({
  maxSize: 5 * 1024 * 1024, // 5MB para desktop
  mobileMaxSize: 2 * 1024 * 1024, // 2MB para mobile
  skipPaths: ['/messages/media', '/download', '/uploads']
}))

// Otimizador JSON para respostas grandes
app.use(jsonOptimizer({
  compressThreshold: 50 * 1024, // 50KB threshold
  removeEmptyFields: true,
  truncateStrings: 1000
}))

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

app.use(express.static(pub, {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0',
  etag: true,
  lastModified: true,
  setHeaders: (res: express.Response, path: string) => {
    // Cache mais agressivo para assets
    if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$/)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable')
    }
    // Cache moderado para HTML
    else if (path.match(/\.html$/)) {
      res.set('Cache-Control', 'public, max-age=3600, must-revalidate')
    }
  }
}))

// Rotas da API
app.use('/api', apiCache) // Cache para rotas de API
app.use('/', apiCache) // Cache para outras rotas específicas
app.use('/', routes)

// Inicializar serviços avançados da Fase 3
startMetaCacheCleaner()

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
