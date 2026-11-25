export const ROUTE_PREFIX = '/plugins/github';
/** A fenced client can still trickle request bytes forever; bound the read. */
export const REQUEST_BODY_TIMEOUT_MS = 5000;
function respond(res, status, value) {
    if (res.destroyed || res.writableEnded)
        return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
}
async function readInput(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
        throw new Error('Expected JSON');
    const deadline = setTimeout(() => req.destroy(), REQUEST_BODY_TIMEOUT_MS);
    const chunks = [];
    let size = 0;
    try {
        for await (const chunk of req) {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += part.length;
            if (size > 8192)
                throw new Error('Request is too large');
            chunks.push(part);
        }
    }
    finally {
        clearTimeout(deadline);
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new Error('Invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Invalid connection request');
    const { source, token } = parsed;
    const keys = Object.keys(parsed);
    if ((source === 'gh' || source === 'oauth') && keys.length === 1)
        return { source };
    if (source === 'token' && typeof token === 'string' && keys.every((key) => key === 'source' || key === 'token'))
        return { source, token };
    throw new Error('Invalid connection request');
}
export function registerRoutes(web, bridge) {
    return web.register({ kind: 'prefix', path: ROUTE_PREFIX, auth: 'required', handler: async (req, res, peer) => {
            if (!peer || peer.signal.aborted) {
                res.writeHead(401).end();
                return;
            }
            const path = new URL(req.url ?? '/', 'http://localhost').pathname;
            try {
                let snapshot;
                if (req.method === 'GET' && path === `${ROUTE_PREFIX}/status`)
                    snapshot = bridge.snapshot();
                else if (req.method === 'POST' && path === `${ROUTE_PREFIX}/connect`) {
                    let input;
                    try {
                        input = await readInput(req);
                    }
                    catch {
                        return respond(res, 400, { ok: false, error: 'Invalid connection request' });
                    }
                    snapshot = await bridge.connect(input);
                }
                else if (req.method === 'POST' && path === `${ROUTE_PREFIX}/cancel`)
                    snapshot = await bridge.cancel();
                else if (req.method === 'POST' && path === `${ROUTE_PREFIX}/disconnect`)
                    snapshot = await bridge.disconnect();
                else
                    return respond(res, 404, { ok: false, error: 'unknown endpoint' });
                respond(res, 200, { ...snapshot, ok: true });
            }
            catch {
                // Do not echo request bodies, authorization headers, or upstream error text here.
                respond(res, 500, { ok: false, error: 'GitHub operation failed; check the connection status' });
            }
        } });
}
