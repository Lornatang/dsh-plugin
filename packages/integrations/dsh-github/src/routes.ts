import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BridgeSnapshot, ConnectInput } from './bridge.js'

export const ROUTE_PREFIX = '/plugins/github'
/** A fenced client can still trickle request bytes forever; bound the read. */
export const REQUEST_BODY_TIMEOUT_MS = 5000
export interface RouteRegistrar { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
export interface RequestFence { requestRejection(req: IncomingMessage): number | undefined }
export interface PluginBridge {
  snapshot(): BridgeSnapshot
  connect(input: ConnectInput): Promise<BridgeSnapshot>
  cancel(): Promise<BridgeSnapshot>
  disconnect(): Promise<BridgeSnapshot>
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function readInput(req: IncomingMessage): Promise<ConnectInput> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('Expected JSON')
  const deadline = setTimeout(() => req.destroy(), REQUEST_BODY_TIMEOUT_MS)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > 8192) throw new Error('Request is too large')
      chunks.push(part)
    }
  } finally { clearTimeout(deadline) }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Invalid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid connection request')
  const value = parsed as Record<string, unknown>
  if (value['source'] === 'gh' && Object.keys(value).length === 1) return { source: 'gh' }
  if (value['source'] === 'oauth' && Object.keys(value).length === 1) return { source: 'oauth' }
  if (value['source'] === 'token' && typeof value['token'] === 'string' && Object.keys(value).every((key) => key === 'source' || key === 'token')) return { source: 'token', token: value['token'] }
  throw new Error('Invalid connection request')
}

export function registerRoutes(web: RouteRegistrar, bridge: PluginBridge, fence: RequestFence | undefined): () => void {
  return web.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: async (req, res) => {
    if (!fence) { respond(res, 503, { ok: false, error: 'DSH connection service is unavailable' }); return }
    const rejection = fence.requestRejection(req)
    if (rejection !== undefined) { res.writeHead(rejection).end(); return }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    try {
      if (req.method === 'GET' && path === `${ROUTE_PREFIX}/status`) { respond(res, 200, { ...bridge.snapshot(), ok: true }); return }
      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/connect`) {
        let input: ConnectInput
        try { input = await readInput(req) } catch { respond(res, 400, { ok: false, error: 'Invalid connection request' }); return }
        respond(res, 200, { ...await bridge.connect(input), ok: true }); return
      }
      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/cancel`) { respond(res, 200, { ...await bridge.cancel(), ok: true }); return }
      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/disconnect`) { respond(res, 200, { ...await bridge.disconnect(), ok: true }); return }
      respond(res, 404, { ok: false, error: 'unknown endpoint' })
    } catch {
      // Do not echo request bodies, authorization headers, or upstream error text here.
      respond(res, 500, { ok: false, error: 'GitHub operation failed; check the connection status' })
    }
  } })
}
