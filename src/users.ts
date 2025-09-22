import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export interface UserRecord {
  id: string // same as email (lowercased) for now
  name: string
  email: string
  passHash: string // format: scrypt$N$r$p$salt$hash
  createdAt: number
  updatedAt: number
}

const DATA_DIR = path.join(process.cwd(), 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')

function ensureDataDir(){ try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {} }

function loadAll(): UserRecord[] {
  ensureDataDir()
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) as UserRecord[] } catch { return [] }
}
function saveAll(list: UserRecord[]) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf8') } catch {}
}

let cache: UserRecord[] | null = null

function db(): UserRecord[] { if(!cache) cache = loadAll(); return cache }

// Simple scrypt wrapper
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const N = 16384, r = 8, p = 1, keylen = 64
  const hash = crypto.scryptSync(password, salt, keylen, { N, r, p }) as Buffer
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    const [algo,Ns,rs,ps,saltB64,hashB64] = stored.split('$')
    if(algo !== 'scrypt') return false
    const N = Number(Ns), r = Number(rs), p = Number(ps)
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const got = crypto.scryptSync(password, salt, expected.length, { N, r, p }) as Buffer
    return crypto.timingSafeEqual(expected, got)
  } catch { return false }
}

export function findUser(email: string): UserRecord | undefined {
  const id = email.toLowerCase()
  return db().find(u => u.id === id)
}

export function createUser(name: string, email: string, password: string): UserRecord {
  const id = email.toLowerCase()
  if(findUser(id)) throw new Error('user_exists')
  const now = Date.now()
  const u: UserRecord = { id, name: name || id.split('@')[0], email: id, passHash: hashPassword(password), createdAt: now, updatedAt: now }
  db().push(u)
  saveAll(db())
  return u
}

export function upsertUserIfMissing(name: string, email: string, password: string): UserRecord {
  const existing = findUser(email)
  if(existing) return existing
  return createUser(name, email, password)
}

export function authenticate(email: string, password: string): UserRecord | null {
  const u = findUser(email)
  if(!u) return null
  if(!verifyPassword(password, u.passHash)) return null
  return u
}

export function listUsers(): UserRecord[] { return [...db()] }
