import { StoredMessage } from './messageStore'

// Simples índice invertido em memória: termo -> Set(messageId)
// Mantemos também mapa de mensagens para scoring rápido.

interface Entry { id: string; text: string; timestamp: number; fromMe: boolean; from: string }

const termMap = new Map<string, Set<string>>()
const msgMap = new Map<string, Entry>()

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9à-úç ]/gi, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && t.length < 40)
}

export function indexMessage(msg: StoredMessage) {
  if (!msg.text) return
  const entry: Entry = { id: msg.id, text: msg.text, timestamp: msg.timestamp, fromMe: msg.fromMe, from: msg.from }
  msgMap.set(msg.id, entry)
  const terms = new Set(tokenize(msg.text))
  for (const t of terms) {
    if (!termMap.has(t)) termMap.set(t, new Set())
    termMap.get(t)!.add(msg.id)
  }
}

export interface SearchResult { id: string; text: string; timestamp: number; score: number; fromMe: boolean; from: string }

export function search(query: string, limit = 20): SearchResult[] {
  const qTerms = tokenize(query)
  if (!qTerms.length) return []
  const scores = new Map<string, number>()
  for (const t of qTerms) {
    const ids = termMap.get(t)
    if (!ids) continue
    for (const id of ids) {
      scores.set(id, (scores.get(id) || 0) + 1)
    }
  }
  const results: SearchResult[] = []
  for (const [id, score] of scores.entries()) {
    const m = msgMap.get(id)
    if (!m) continue
    // heurística: boost por recência
    const ageHours = (Date.now() - m.timestamp) / 3600000
    const recencyBoost = ageHours < 1 ? 1.5 : ageHours < 24 ? 1.2 : 1
    results.push({ id, text: m.text, timestamp: m.timestamp, score: score * recencyBoost, fromMe: m.fromMe, from: m.from })
  }
  return results
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
    .slice(0, limit)
}
