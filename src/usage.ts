import fs from 'fs'
import path from 'path'

const DATA_FILE = path.join(process.cwd(), 'data', 'usage.json')

interface UsageEntry { total: number; today: number; date: string }
interface UsageStore { [sessionId: string]: UsageEntry }

let store: UsageStore = {}
function load(){ try { store = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')) } catch { store = {} } }
function save(){ try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive:true }); fs.writeFileSync(DATA_FILE, JSON.stringify(store,null,2)) } catch {} }
load()

export const DEFAULT_PLAN = { name: 'Free', quotaDaily: 500, expiresAt: null as null }

export function getPlan(_userId: string){
  // Futuro: carregar de arquivo/DB; hoje sempre default
  return DEFAULT_PLAN
}

function roll(entry: UsageEntry){
  const todayStr = new Date().toISOString().slice(0,10)
  if(entry.date !== todayStr){ entry.date = todayStr; entry.today = 0 }
  return entry
}

function getEntry(sessionId: string){
  let e = store[sessionId]
  if(!e){ e = { total:0, today:0, date: new Date().toISOString().slice(0,10) }; store[sessionId] = e }
  return roll(e)
}

export function recordMessage(sessionId: string){
  const e = getEntry(sessionId)
  e.today += 1; e.total += 1; save()
  return { today: e.today, total: e.total }
}

export function getUsage(sessionId: string){
  const e = getEntry(sessionId)
  return { messagesToday: e.today, total: e.total }
}

export function checkQuota(userId: string, sessionId: string){
  const plan = getPlan(userId)
  const { messagesToday } = getUsage(sessionId)
  const remaining = plan.quotaDaily - messagesToday
  if(remaining <= 0){
    return { ok:false, remaining:0, plan }
  }
  return { ok:true, remaining, plan }
}
