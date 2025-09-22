/** Simple in-memory throttling & rate limiting utilities.
 * NOT distributed; resets on process restart.
 */

interface Bucket {
  tokens: number
  lastRefill: number
}

const creationWindowMs = 60_000
const creationLimit = Number(process.env.SESSION_CREATE_PER_MIN || '5') // per IP
const globalCreationLimit = Number(process.env.SESSION_CREATE_GLOBAL_PER_MIN || '30')
const creationHits: Record<string, number[]> = {}
let globalHits: number[] = []

export function canCreateSession(ip: string){
  const now = Date.now()
  // cleanup
  for(const k of Object.keys(creationHits)){
    creationHits[k] = creationHits[k].filter(ts => now - ts < creationWindowMs)
    if(!creationHits[k].length) delete creationHits[k]
  }
  globalHits = globalHits.filter(ts => now - ts < creationWindowMs)

  if(!creationHits[ip]) creationHits[ip] = []
  if(creationHits[ip].length >= creationLimit) return { ok:false, reason:'per_ip_limit' }
  if(globalHits.length >= globalCreationLimit) return { ok:false, reason:'global_limit' }
  creationHits[ip].push(now)
  globalHits.push(now)
  return { ok:true }
}

// Message send token bucket per session
const sendBuckets = new Map<string, Bucket>()
const SEND_REFILL_PER_SEC = Number(process.env.SEND_REFILL_RATE || '1') // tokens added per second
const SEND_BUCKET_CAP = Number(process.env.SEND_BUCKET_CAP || '20') // max burst

export function takeSendToken(sessionId: string){
  const now = Date.now()
  let b = sendBuckets.get(sessionId)
  if(!b){ b = { tokens: SEND_BUCKET_CAP, lastRefill: now }; sendBuckets.set(sessionId, b) }
  // refill
  const elapsed = (now - b.lastRefill)/1000
  if(elapsed > 0){
    const add = elapsed * SEND_REFILL_PER_SEC
    b.tokens = Math.min(SEND_BUCKET_CAP, b.tokens + add)
    b.lastRefill = now
  }
  if(b.tokens >= 1){
    b.tokens -= 1
    return { ok:true, remaining: b.tokens }
  }
  return { ok:false, remaining: b.tokens }
}

export function snapshotRateState(){
  const send: Record<string, number> = {}
  for(const [id, b] of sendBuckets.entries()) send[id] = Number(b.tokens.toFixed(2))
  return { sendBuckets: send, creationPerIp: Object.fromEntries(Object.entries(creationHits).map(([k,v])=>[k,v.length])), globalCreatesLastMin: globalHits.length }
}
