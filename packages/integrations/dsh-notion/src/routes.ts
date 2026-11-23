import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BridgeSnapshot } from './bridge.js'

export const ROUTE_PREFIX = '/plugins/notion'
export interface RouteRegistrar {
  register(route: {
    kind: 'prefix'
    path: string
    auth: 'required'
    handler: (req: IncomingMessage, res: ServerResponse, peer?: { signal: AbortSignal }) => void | Promise<void>
  }): () => void
}
export interface PluginBridge {
  snapshot(): BridgeSnapshot
  authorize(): Promise<BridgeSnapshot>
  disconnect(): Promise<BridgeSnapshot>
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

export function registerRoutes(web: RouteRegistrar, bridge: PluginBridge): () => void {
  return web.register({ kind: 'prefix', path: ROUTE_PREFIX, auth: 'required', handler: async (req, res, peer) => {
    if (!peer || peer.signal.aborted) { res.writeHead(401).end(); return }
    try {
      let path: string
      try { path = new URL(req.url ?? '/', 'http://localhost').pathname } catch { respond(res, 400, { ok: false, error: 'invalid request target' }); return }
      if (req.method === 'GET' && path === `${ROUTE_PREFIX}/status`) { respond(res, 200, { ...bridge.snapshot(), ok: true }); return }
      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/connect`) { respond(res, 200, { ...await bridge.authorize(), ok: true }); return }
      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/disconnect`) { respond(res, 200, { ...await bridge.disconnect(), ok: true }); return }
      respond(res, 404, { ok: false, error: 'unknown endpoint' })
    } catch {
      // Never echo upstream error text here: it can carry OAuth response bodies.
      respond(res, 500, { ok: false, error: 'Notion operation failed; check the connection status' })
    }
  } })
}
