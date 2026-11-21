import { setTimeout as delay } from 'node:timers/promises';
import { limitResponse } from './response-limit.js';
const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const VERIFICATION_URL = 'https://github.com/login/device';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_SCOPES = ['repo', 'read:org', 'workflow', 'read:user', 'notifications', 'read:project', 'gist', 'security_events'];
const GITHUB_SCOPES = new Set([
    'repo', 'repo:status', 'repo_deployment', 'public_repo', 'repo:invite', 'security_events',
    'admin:repo_hook', 'write:repo_hook', 'read:repo_hook', 'admin:org', 'write:org', 'read:org',
    'admin:public_key', 'write:public_key', 'read:public_key', 'admin:org_hook', 'gist', 'notifications',
    'user', 'read:user', 'user:email', 'user:follow', 'project', 'read:project', 'delete_repo',
    'write:packages', 'read:packages', 'delete:packages', 'admin:gpg_key', 'write:gpg_key', 'read:gpg_key',
    'codespace', 'workflow', 'read:audit_log', 'offline_access',
    'admin:enterprise', 'read:enterprise', 'manage_runners:enterprise', 'manage_billing:enterprise',
]);
async function post(url, body, signal) {
    const response = await globalThis.fetch(url, {
        method: 'POST', body, redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    const limited = await limitResponse(response, MAX_OAUTH_RESPONSE_BYTES, () => undefined);
    let value;
    try {
        value = await limited.json();
    }
    catch {
        throw new Error('GitHub authorization returned an invalid response');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('GitHub authorization returned an invalid response');
    if (!response.ok && !value['error'])
        throw new Error('GitHub authorization request failed');
    return value;
}
function oauthError(value) {
    switch (value) {
        case 'access_denied': return new Error('GitHub authorization was declined');
        case 'expired_token': return new Error('GitHub authorization expired; connect again');
        case 'device_flow_disabled': return new Error('GitHub device authorization is not enabled for this application');
        case 'incorrect_client_credentials': return new Error('GitHub authorization application is not configured correctly');
        default: return new Error('GitHub authorization failed; connect again');
    }
}
export function parseRequestedScopes(value) {
    if (!value || value.length > 1024)
        return undefined;
    const scopes = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
    if (!scopes.length || scopes.length > 20 || scopes.some((scope) => !GITHUB_SCOPES.has(scope)))
        return undefined;
    return scopes;
}
export async function startDeviceAuthorization(clientId, signal, additionalScopes = []) {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(clientId))
        throw new Error('GitHub browser authorization is not configured; contact the plugin maintainer');
    if (additionalScopes.some((scope) => !GITHUB_SCOPES.has(scope)))
        throw new Error('GitHub requested an unsupported authorization scope');
    const scope = [...new Set([...DEFAULT_SCOPES, ...additionalScopes])].join(' ');
    const value = await post(DEVICE_URL, new URLSearchParams({ client_id: clientId, scope }), signal);
    if (value['error'])
        throw oauthError(value['error']);
    const deviceCode = value['device_code'];
    const userCode = value['user_code'];
    const verificationUri = value['verification_uri'];
    const expiresIn = value['expires_in'];
    const interval = value['interval'];
    if (typeof deviceCode !== 'string' || !/^[A-Za-z0-9._~-]{1,256}$/.test(deviceCode) ||
        typeof userCode !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(userCode) ||
        verificationUri !== VERIFICATION_URL || typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 86400 ||
        typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 300) {
        throw new Error('GitHub authorization returned an invalid response');
    }
    return { deviceCode, userCode, verificationUri, expiresAt: Date.now() + expiresIn * 1000, intervalMs: interval * 1000 };
}
function readTokens(value) {
    const accessToken = value['access_token'];
    const refreshToken = value['refresh_token'];
    const expiresIn = value['expires_in'];
    const grantedScopes = value['scope'];
    const validToken = (token) => typeof token === 'string' && token.length > 0 && token.length <= 4096 && /^[A-Za-z0-9._~+/=-]+$/.test(token);
    if (!validToken(accessToken) || String(value['token_type']).toLowerCase() !== 'bearer' ||
        (refreshToken !== undefined && !validToken(refreshToken)) || (grantedScopes !== undefined && (typeof grantedScopes !== 'string' || grantedScopes.length > 2048)) ||
        (expiresIn !== undefined && (typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 31536000 || !validToken(refreshToken)))) {
        throw new Error('GitHub authorization returned an invalid token response');
    }
    const scopes = typeof grantedScopes === 'string' ? [...new Set(grantedScopes.split(/[\s,]+/).filter((scope) => GITHUB_SCOPES.has(scope)))] : undefined;
    return { accessToken, refreshToken, expiresAt: typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : undefined, scopes };
}
export async function waitForDeviceToken(clientId, authorization, signal) {
    let intervalMs = authorization.intervalMs;
    while (Date.now() < authorization.expiresAt) {
        await delay(Math.min(intervalMs, Math.max(0, authorization.expiresAt - Date.now())), undefined, { signal });
        if (Date.now() >= authorization.expiresAt)
            break;
        const value = await post(TOKEN_URL, new URLSearchParams({ client_id: clientId, device_code: authorization.deviceCode, grant_type: DEVICE_GRANT }), signal);
        if (value['error'] === 'authorization_pending')
            continue;
        if (value['error'] === 'slow_down') {
            intervalMs += 5000;
            continue;
        }
        if (value['error'])
            throw oauthError(value['error']);
        return readTokens(value);
    }
    throw new Error('GitHub authorization expired; connect again');
}
export async function refreshDeviceToken(clientId, refreshToken, signal) {
    const value = await post(TOKEN_URL, new URLSearchParams({ client_id: clientId, refresh_token: refreshToken, grant_type: 'refresh_token' }), signal);
    if (value['error'])
        throw new Error('GitHub authorization expired; connect again');
    return readTokens(value);
}
