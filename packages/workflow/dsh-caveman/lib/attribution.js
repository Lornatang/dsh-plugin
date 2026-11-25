import { createHash } from 'node:crypto';
import { localOrigin } from './runtime.js';
export function cavemanSessionId(sessionId) {
    return `dsh-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
}
export function cavemanRequestHeaders(endpoint, request, headers) {
    try {
        const target = localOrigin(endpoint);
        const base = new URL(request.baseURL);
        if (!target || base.origin !== target.origin || base.username || base.password)
            return headers;
        if (!headers.has('x-cave-agent'))
            headers.set('x-cave-agent', 'dsh');
        if (request.sessionId && !headers.has('x-cave-session')) {
            headers.set('x-cave-session', cavemanSessionId(request.sessionId));
        }
    }
    catch { /* Headers supplied by another handler may be immutable. */ }
    return headers;
}
export function registerAttribution(ctx, endpoint) {
    ctx.on('llm-pi-ai/request-headers', (request, _headers, next) => cavemanRequestHeaders(endpoint, request, next()));
}
