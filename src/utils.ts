import fs from 'fs'
import path from 'path'
import { JsonErr } from './types'

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function jsonError(error: string, message?: string): JsonErr {
  return { error, ...(message ? { message } : {}) }
}

export function resolveSessionPath(sessionId: string) {
  return path.join(process.cwd(), 'sessions', sessionId)
}