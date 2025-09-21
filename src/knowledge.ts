import fs from 'fs'
import path from 'path'

export interface KnowledgeSection {
  heading: string
  content: string
  raw: string
  index: number
  score?: number
}

interface KnowledgeCache {
  loadedAt: number
  mtimeMs: number
  raw: string
  sections: KnowledgeSection[]
}

let cache: KnowledgeCache | null = null

const FILE_PATH = path.join(process.cwd(), 'data', 'knowledge', 'main.md')

function parseSections(raw: string): KnowledgeSection[] {
  const lines = raw.split(/\r?\n/)
  // remove frontmatter if exists
  let start = 0
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { start = i + 1; break }
    }
  }
  const body = lines.slice(start)
  const sections: KnowledgeSection[] = []
  let current: KnowledgeSection | null = null
  body.forEach((line) => {
    const h = /^(#{1,2})\s+(.*)/.exec(line)
    if (h) {
      if (current) sections.push(current)
      current = { heading: h[2].trim(), content: '', raw: line + '\n', index: sections.length }
    } else if (current) {
      current.content += line + '\n'
      current.raw += line + '\n'
    }
  })
  if (current) sections.push(current)
  return sections
}

export function loadKnowledge(): KnowledgeCache {
  try {
    const stat = fs.statSync(FILE_PATH)
    if (cache && stat.mtimeMs === cache.mtimeMs) return cache
    const raw = fs.readFileSync(FILE_PATH, 'utf8')
    const sections = parseSections(raw)
    cache = { loadedAt: Date.now(), mtimeMs: stat.mtimeMs, raw, sections }
    return cache
  } catch {
    cache = { loadedAt: Date.now(), mtimeMs: 0, raw: '', sections: [] }
    return cache
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9\sçáàâãéèêíïóôõöúüñ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

const STOP = new Set(['a','o','e','de','do','da','para','em','um','uma','de','que','no','na','os','as','por','com','se','ao','à'])

export function selectSections(question: string, maxChars = 4000): KnowledgeSection[] {
  const { sections } = loadKnowledge()
  if (!question.trim()) return sections.slice(0, 3)
  const qTokens = tokenize(question).filter(t => !STOP.has(t))
  const scored = sections.map(s => {
    const text = (s.heading + ' ' + s.content).toLowerCase()
    let score = 0
    for (const qt of qTokens) {
      if (text.includes(qt)) score += 1
      if (s.heading.toLowerCase().includes(qt)) score += 2
    }
    return { ...s, score }
  })
  scored.sort((a,b)=> (b.score||0) - (a.score||0))
  const picked: KnowledgeSection[] = []
  let total = 0
  for (const s of scored) {
    if (s.score === 0 && picked.length) break
    if (total + s.raw.length > maxChars) break
    picked.push(s)
    total += s.raw.length
    if (picked.length >= 5) break
  }
  return picked
}

export function updateKnowledge(content: string) {
  fs.writeFileSync(FILE_PATH, content, 'utf8')
  cache = null
}
