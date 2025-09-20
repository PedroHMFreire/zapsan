// src/server.ts
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import { setDefaultResultOrder } from 'dns'
import path from 'path'
import fs from 'fs'
import routes from './routes'

try { setDefaultResultOrder('ipv4first') } catch {}

const app = express()
app.use(cors())
app.use(express.json())
app.use(morgan('dev'))

// API original
app.use('/', routes)

// ---- FRONT (serve SPA) ----
function detectStaticDir(): string | null {
  const candidates = [
    process.env.STATIC_DIR || '',
    path.resolve(process.cwd(), 'public'),
    path.resolve(process.cwd(), 'dist'),
    path.resolve(process.cwd(), 'build'),
    path.resolve(process.cwd(), 'client', 'dist'),
    path.resolve(process.cwd(), 'frontend', 'dist'),
  ].filter(Boolean)
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'index.html'))) return dir
    } catch {}
  }
  return null
}

const STATIC_DIR = detectStaticDir()
if (STATIC_DIR) {
  app.use(express.static(STATIC_DIR))
  app.get('*', (req, res, next) => {
    const isApi = req.path.startsWith('/sessions') || req.path.startsWith('/messages') || req.path.startsWith('/health')
    if (isApi) return next()
    res.sendFile(path.join(STATIC_DIR, 'index.html'))
  })
}

// ---- LISTEN (evita 2x listen quando importado) ----
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.sep + 'server.ts')

if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Servidor online na :${PORT}${STATIC_DIR ? ` | static: ${STATIC_DIR}` : ''}`)
  })
}

export default app
