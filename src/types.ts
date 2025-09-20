export type ReplyInput = {
  text: string
  from: string
  sessionId: string
}

export type JsonOk = { ok: true; [k: string]: any }
export type JsonErr = { error: string; message?: string }