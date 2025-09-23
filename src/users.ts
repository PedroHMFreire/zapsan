import crypto from 'crypto'
import { supa } from './db'

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
  const passwordHash = await hash(password)
  // Tenta inserção direta; se já existir, detectar conflito e lançar user_exists
  const { data, error } = await supa.from('users').insert({ phone, name: name || null, passwordHash }).select('*').single()
  if(error){
    const msg = error.message || ''
    if(/duplicate|unique|23505/i.test(msg)) throw new Error('user_exists')
    throw new Error(msg || 'create_failed')
  }
  return toPublic(data)
}

export async function verifyLogin({ phone, password }: { phone: string; password: string }): Promise<{ ok: boolean; user?: UserPublic }> {
  const { data: u } = await supa.from('users').select('id, phone, name, passwordHash, createdAt').eq('phone', phone).single()
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
  let query = supa.from('users').select('id, phone, name, createdAt')
  if(where.id){ query = query.eq('id', where.id) }
  if(where.phone){ query = query.eq('phone', where.phone) }
  const { data: u } = await query.single()
  if(!u) return null
  return toPublic(u)
}

export async function listUsers(): Promise<UserPublic[]> {
  const { data, error } = await supa.from('users').select('id, phone, name, createdAt').order('createdAt', { ascending: false })
  if(error) return []
  return (data||[]).map(toPublic)
}

export async function updateUser(id: string, patch: { name?: string; phone?: string; password?: string }): Promise<UserPublic> {
  const { data: existing } = await supa.from('users').select('id').eq('id', id).single()
  if(!existing) throw new Error('user_not_found')
  const data: any = {}
  if(typeof patch.name === 'string') data.name = patch.name
  if(typeof patch.phone === 'string') data.phone = patch.phone
  if(typeof patch.password === 'string' && patch.password){
    data.passwordHash = await hash(patch.password)
  }
  const { data: updated, error } = await supa.from('users').update(data).eq('id', id).select('id, phone, name, createdAt').single()
  if(error || !updated) throw new Error('update_failed')
  return toPublic(updated)
}

export async function deleteUser(id: string): Promise<void> {
  const { error } = await supa.from('users').delete().eq('id', id)
  if(error){
    if(/not.*found/i.test(error.message||'')) throw new Error('user_not_found')
    // Supabase delete silent se 0 rows; checar contagem seria outra query (omitimos para simplicidade)
  }
}

// Compatibilidade com rotas antigas que usam authenticate / upsertUserIfMissing / findUser
// Mantemos assinaturas mas redirecionamos para novas funções (mapeando email->phone)
export async function findUser(phone: string){
  const { data } = await supa.from('users').select('*').eq('phone', phone).single()
  return data || null
}

export async function upsertUserIfMissing(name: string, phone: string, password: string){
  const { data: u } = await supa.from('users').select('*').eq('phone', phone).single()
  if(u) return u
  const created = await createUser({ phone, name, password })
  return { id: created.id, phone: created.phone, name: created.name, createdAt: created.createdAt }
}

export async function authenticate(phone: string, password: string){
  const { ok, user } = await verifyLogin({ phone, password })
  if(!ok || !user) return null
  return { id: user.id, phone: user.phone, name: user.name }
}
