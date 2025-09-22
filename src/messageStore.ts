import fs from 'fs'
import path from 'path'

export interface StoredMessage {
  id: string
  from: string
  to?: string
  text: string
  timestamp: number
  fromMe: boolean
  pushName?: string
  mediaType?: string
  mediaPath?: string
  status?: string // ack status etc
}

interface MessageIndex {
  messages: StoredMessage[]
}

const DATA_DIR = path.join(process.cwd(), 'data')
const MSG_DIR = path.join(DATA_DIR, 'messages')

function ensureDirs() {
  try { fs.mkdirSync(MSG_DIR, { recursive: true }) } catch {}
}
ensureDirs()

// Debounce controlar múltiplas escritas próximas
const pendingWrites = new Map<string, NodeJS.Timeout>()
const caches = new Map<string, MessageIndex>()

function filePath(sessionId: string) {
  return path.join(MSG_DIR, `${sessionId}.json`)
}

function load(sessionId: string): MessageIndex {
  const cached = caches.get(sessionId)
  if (cached) return cached
  let idx: MessageIndex = { messages: [] }
  try {
    const raw = fs.readFileSync(filePath(sessionId), 'utf8')
    idx = JSON.parse(raw)
  } catch {}
  caches.set(sessionId, idx)
  return idx
}

function scheduleSave(sessionId: string) {
  if (pendingWrites.has(sessionId)) return
  const t = setTimeout(() => {
    pendingWrites.delete(sessionId)
    const idx = caches.get(sessionId)
    if (!idx) return
    try {
      fs.writeFileSync(filePath(sessionId), JSON.stringify(idx, null, 2), 'utf8')
    } catch {}
  }, 1000) // 1s debounce
  pendingWrites.set(sessionId, t)
}

export function appendMessage(sessionId: string, msg: StoredMessage) {
  const idx = load(sessionId)
  idx.messages.push(msg)
  // proteção de tamanho
  if (idx.messages.length > 5000) {
    idx.messages.splice(0, idx.messages.length - 5000)
  }
  scheduleSave(sessionId)
}

export function updateMessageStatus(sessionId: string, id: string, status: string) {
  const idx = load(sessionId)
  const m = idx.messages.find(m => m.id === id)
  if (m) {
    m.status = status
    scheduleSave(sessionId)
  }
}

export interface QueryOptions {
  limit?: number
  before?: number
  after?: number
  from?: string
  direction?: 'in' | 'out'
  search?: string
}

export function queryMessages(sessionId: string, opts: QueryOptions): StoredMessage[] {
  const idx = load(sessionId)
  let list = idx.messages
  if (opts.after) list = list.filter(m => m.timestamp > opts.after!)
  if (opts.before) list = list.filter(m => m.timestamp < opts.before!)
  if (opts.from) list = list.filter(m => m.from === opts.from || m.to === opts.from)
  if (opts.direction === 'in') list = list.filter(m => !m.fromMe)
  if (opts.direction === 'out') list = list.filter(m => m.fromMe)
  if (opts.search) {
    const q = opts.search.toLowerCase()
    list = list.filter(m => m.text.toLowerCase().includes(q))
  }
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 100
  return list.slice(-limit)
}
