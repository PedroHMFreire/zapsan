import fs from 'fs'
import path from 'path'
import { createOrLoadSession } from './wa'

const DATA_FILE = path.join(process.cwd(), 'data', 'user-sessions.json')
type MapShape = { [userId: string]: string }
let mapping: MapShape = {}

function load(){
  try { mapping = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')) } catch { mapping = {} }
}
function save(){
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive:true }) } catch {}
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(mapping, null, 2)) } catch {}
}
load()

export function getOrCreateUserSession(userId: string){
  if(!userId) throw new Error('missing_user')
  let sid = mapping[userId]
  if(!sid){
    sid = 'u_' + userId
    mapping[userId] = sid
    save()
  }
  return sid
}

export async function ensureSessionStarted(userId: string){
  const sid = getOrCreateUserSession(userId)
  // inicia se ainda não estiver em memória
  await createOrLoadSession(sid)
  return sid
}

export function listUserSessions(){
  return { ...mapping }
}
