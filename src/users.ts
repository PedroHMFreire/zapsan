import crypto from 'crypto'
import { prisma } from './db'

// Mantemos compatibilidade mínima exportando tipos semelhantes aos antigos (campos públicos)
export interface UserPublic {
  id: string
  phone: string
  name?: string | null
  createdAt: Date
}

// === Hash helpers (scrypt) ===
function hash(password: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const N = 16384, r = 8, p = 1, keylen = 64
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p }, (err, derived) => {
      if (err) return reject(err)
      resolve(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${(derived as Buffer).toString('base64')}`)
    })
  })
}

function verify(password: string, stored?: string | null): Promise<boolean> {
  if(!stored) return Promise.resolve(false)
  try {
    const [algo,Ns,rs,ps,saltB64,hashB64] = stored.split('$')
    if(algo !== 'scrypt') return Promise.resolve(false)
    const N = Number(Ns), r = Number(rs), p = Number(ps)
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    return new Promise((resolve) => {
      crypto.scrypt(password, salt, expected.length, { N, r, p }, (err, derived) => {
        if(err) return resolve(false)
        try { resolve(crypto.timingSafeEqual(expected, derived as Buffer)) } catch { resolve(false) }
      })
    })
  } catch { return Promise.resolve(false) }
}

// === Mapeadores ===
function toPublic(u: any): UserPublic { return { id: u.id, phone: u.phone, name: u.name, createdAt: u.createdAt } }

// === Funções exigidas pela nova API (phone baseado) ===
export async function createUser({ phone, name, password }: { phone: string; name?: string; password: string }): Promise<UserPublic> {
  const exists = await prisma.user.findUnique({ where: { phone } })
  if(exists) throw new Error('user_exists')
  const passwordHash = await hash(password)
  const u = await prisma.user.create({ data: { phone, name, passwordHash } })
  return toPublic(u)
}

export async function verifyLogin({ phone, password }: { phone: string; password: string }): Promise<{ ok: boolean; user?: UserPublic }> {
  const u = await prisma.user.findUnique({ where: { phone } })
  if(!u) return { ok:false }
  const ok = await verify(password, u.passwordHash)
  if(!ok) return { ok:false }
  return { ok:true, user: toPublic(u) }
}

export async function getUser(idOrPhone: string): Promise<UserPublic | null> {
  let where: any
  if(/^[0-9a-fA-F-]{36}$/.test(idOrPhone) || idOrPhone.startsWith('u_')){ // uuid simples ou prefixado
    where = { id: idOrPhone }
  } else {
    where = { phone: idOrPhone }
  }
  const u = await prisma.user.findUnique({ where })
  if(!u) return null
  return toPublic(u)
}

export async function listUsers(): Promise<UserPublic[]> {
  const list = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } })
  return list.map(toPublic)
}

export async function updateUser(id: string, patch: { name?: string; phone?: string; password?: string }): Promise<UserPublic> {
  const existing = await prisma.user.findUnique({ where: { id } })
  if(!existing) throw new Error('user_not_found')
  const data: any = {}
  if(typeof patch.name === 'string') data.name = patch.name
  if(typeof patch.phone === 'string') data.phone = patch.phone
  if(typeof patch.password === 'string' && patch.password){
    data.passwordHash = await hash(patch.password)
  }
  const u = await prisma.user.update({ where: { id }, data })
  return toPublic(u)
}

export async function deleteUser(id: string): Promise<void> {
  try {
    await prisma.user.delete({ where: { id } })
  } catch (err:any){
    if(err.code === 'P2025') throw new Error('user_not_found')
    throw err
  }
}

// Compatibilidade com rotas antigas que usam authenticate / upsertUserIfMissing / findUser
// Mantemos assinaturas mas redirecionamos para novas funções (mapeando email->phone)
export async function findUser(phone: string){
  return prisma.user.findUnique({ where: { phone } })
}

export async function upsertUserIfMissing(name: string, phone: string, password: string){
  const u = await prisma.user.findUnique({ where: { phone } })
  if(u) return u
  const created = await createUser({ phone, name, password })
  return { id: created.id, phone: created.phone, name: created.name, createdAt: created.createdAt }
}

export async function authenticate(phone: string, password: string){
  const { ok, user } = await verifyLogin({ phone, password })
  if(!ok || !user) return null
  return { id: user.id, phone: user.phone, name: user.name }
}
