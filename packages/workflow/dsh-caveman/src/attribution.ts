import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm-pi-ai'
import { localOrigin } from './runtime.js'

export function cavemanSessionId(sessionId: string): string {
  return `dsh-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`
}

export function cavemanRequestHeaders(endpoint: string, request: { baseURL: string; sessionId?: string }, headers: Headers): Headers {
  try {
    const target = localOrigin(endpoint)
    const base = new URL(request.baseURL)
    if (!target || base.origin !== target.origin || base.username || base.password) return headers
    if (!headers.has('x-cave-agent')) headers.set('x-cave-agent', 'dsh')
    if (request.sessionId && !headers.has('x-cave-session')) {
      headers.set('x-cave-session', cavemanSessionId(request.sessionId))
    }
  } catch { /* Headers supplied by another handler may be immutable. */ }
  return headers
}

export function registerAttribution(ctx: Context, endpoint: string): void {
  ctx.on('llm-pi-ai/request-headers', (request, _headers, next) => cavemanRequestHeaders(endpoint, request, next()))
}
