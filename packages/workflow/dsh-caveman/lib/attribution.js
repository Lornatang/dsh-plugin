import { createHash } from 'node:crypto';
/** Attribute only requests routed to the configured loopback proxy. */
export function cavemanSessionId(sessionId) {
    return `dsh-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
}
export function cavemanRequestHeaders(endpoint, request, headers) {
    try {
        const target = new URL(endpoint);
        const base = new URL(request.baseURL);
        if (target.protocol !== 'http:' || target.username || target.password ||
            !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || base.origin !== target.origin || base.username || base.password)
            return headers;
        if (!headers.has('x-cave-agent'))
            headers.set('x-cave-agent', 'dsh');
        if (request.sessionId && !headers.has('x-cave-session')) {
            headers.set('x-cave-session', cavemanSessionId(request.sessionId));
        }
    }
    catch { /* Invalid or unrelated routes keep their existing headers. */ }
    return headers;
}
export function registerAttribution(ctx, endpoint) {
    ctx.on('llm-pi-ai/request-headers', (request, _headers, next) => cavemanRequestHeaders(endpoint, request, next()));
}
