import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { limitResponse, MAX_RESPONSE_BYTES } from './response-limit.js';
function isLoopback(url) {
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
/** Keep credentials on the configured origin and never follow redirects implicitly. */
export function createGithubFetch(server, token, toolsets, readOnly, options = {}) {
    const allowed = (url) => !url.username && !url.password &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(server) && isLoopback(url))) &&
        url.origin === server.origin;
    if (!allowed(server))
        throw new Error('github: MCP endpoint must use HTTPS or loopback HTTP without embedded credentials');
    const validate = (value) => {
        if (!value || /[\r\n]/.test(value) || value.length > 4096)
            throw new Error('github: invalid token');
        return value;
    };
    if (typeof token === 'string')
        validate(token);
    if (!/^[a-z0-9_, -]*$/i.test(toolsets))
        throw new Error('github: invalid toolset list');
    return async (value, init) => {
        const target = new URL(value);
        if (!allowed(target))
            throw new Error('github: request must remain on the configured MCP origin');
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${validate(typeof token === 'string' ? token : await token())}`);
        if (toolsets)
            headers.set('X-MCP-Toolsets', toolsets);
        if (readOnly)
            headers.set('X-MCP-Readonly', 'true');
        const response = await globalThis.fetch(target, { ...init, headers, redirect: 'manual' });
        if (response.status === 403 && options.onInsufficientScope) {
            const challenge = extractWWWAuthenticateParams(response);
            if (challenge.error === 'insufficient_scope' && challenge.scope) {
                const message = options.onInsufficientScope(challenge.scope);
                if (message) {
                    await response.body?.cancel();
                    throw new Error(message);
                }
            }
        }
        return limitResponse(response, MAX_RESPONSE_BYTES, options.onLimit ?? (() => undefined), options.onEvent);
    };
}
