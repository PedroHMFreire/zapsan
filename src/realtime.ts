import { Response, Request } from 'express'

interface Client {
  id: string
  res: Response
  sessionId: string
}

const clients = new Map<string, Client>()

export function sseHandler(req: Request, res: Response) {
  const { id } = req.params
  const clientId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  res.write(`event: ready\n`)
  res.write(`data: {"ok":true}\n\n`)
  const c: Client = { id: clientId, res, sessionId: id }
  clients.set(clientId, c)
  req.on('close', () => {
    clients.delete(clientId)
  })
}

export function broadcast(sessionId: string, event: string, payload: any) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const c of clients.values()) {
    if (c.sessionId === sessionId) {
      try { c.res.write(data) } catch {}
    }
  }
}
