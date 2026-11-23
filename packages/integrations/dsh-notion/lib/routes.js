export const ROUTE_PREFIX = '/plugins/notion';
function respond(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
}
export function registerRoutes(web, bridge) {
    return web.register({ kind: 'prefix', path: ROUTE_PREFIX, auth: 'required', handler: async (req, res, peer) => {
            if (!peer || peer.signal.aborted) {
                res.writeHead(401).end();
                return;
            }
            try {
                let path;
                try {
                    path = new URL(req.url ?? '/', 'http://localhost').pathname;
                }
                catch {
                    respond(res, 400, { ok: false, error: 'invalid request target' });
                    return;
                }
                if (req.method === 'GET' && path === `${ROUTE_PREFIX}/status`) {
                    respond(res, 200, { ...bridge.snapshot(), ok: true });
                    return;
                }
                if (req.method === 'POST' && path === `${ROUTE_PREFIX}/connect`) {
                    respond(res, 200, { ...await bridge.authorize(), ok: true });
                    return;
                }
                if (req.method === 'POST' && path === `${ROUTE_PREFIX}/disconnect`) {
                    respond(res, 200, { ...await bridge.disconnect(), ok: true });
                    return;
                }
                respond(res, 404, { ok: false, error: 'unknown endpoint' });
            }
            catch {
                // Never echo upstream error text here: it can carry OAuth response bodies.
                respond(res, 500, { ok: false, error: 'Notion operation failed; check the connection status' });
            }
        } });
}
