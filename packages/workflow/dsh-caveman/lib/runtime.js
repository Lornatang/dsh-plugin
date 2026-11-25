import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
export const NATIVE_PROFILES = new Set(['record-only', 'core', 'core-lean-build', 'ledger', 'ccr-masking', 'cache-aware', 'full-safe', 'full-max']);
export function cavemanHome(env = process.env) {
    return env.CAVEMAN_HOME ?? join(homedir(), '.caveman');
}
function executable(path) {
    try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function pathCommand(name, env) {
    const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
    const names = process.platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? [name, `${name}.exe`] : [name];
    for (const dir of dirs)
        for (const candidate of names) {
            const path = resolve(dir, candidate);
            if (executable(path))
                return path;
        }
    return undefined;
}
/** Find a configured binary, PATH command, or the CLI's installation. */
export function findCavemanBinary(kind, configured, env = process.env) {
    if (configured !== undefined) {
        if (!isAbsolute(configured))
            throw new Error(`dsh-caveman: ${kind}Binary must be an absolute path`);
        if (!executable(configured))
            throw new Error(`dsh-caveman: ${kind}Binary is not an executable file: ${configured}`);
        return configured;
    }
    const override = env[{ blocks: 'CAVEMAN_BLOCKS_BIN', browse: 'CAVEMAN_BROWSE_BIN', mcp: 'CAVEMAN_MCP_BIN', memory: 'CAVEMEM_BIN' }[kind]];
    if (override) {
        if (isAbsolute(override) || /[\\/]/u.test(override)) {
            const absolute = resolve(override);
            return executable(absolute) ? absolute : undefined;
        }
        return pathCommand(override, env);
    }
    const name = kind === 'memory' ? 'cavemem' : `caveman-${kind}`;
    const onPath = pathCommand(name, env);
    if (onPath)
        return onPath;
    const filename = process.platform === 'win32' ? `${name}.exe` : name;
    const local = resolve(cavemanHome(env), 'bin', filename);
    return executable(local) ? local : undefined;
}
function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function configDocument(env) {
    try {
        let raw;
        try {
            raw = readFileSync(join(cavemanHome(env), 'cloud.json'), 'utf8');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            raw = readFileSync(join(homedir(), '.caveman-cloud', 'config.json'), 'utf8');
        }
        return object(JSON.parse(raw.replace(/^\uFEFF/u, '')));
    }
    catch {
        return {};
    }
}
function booleanSetting(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized))
        return true;
    if (['0', 'false', 'no', 'off'].includes(normalized))
        return false;
    return undefined;
}
export function runtimeSettings(env = process.env) {
    const document = configDocument(env);
    const modules = object(document.modules);
    const think = object(document.think);
    const wrap = object(document.wrap);
    const explicit = (value) => typeof value === 'boolean' ? value : undefined;
    const input = explicit(modules.input) ?? ((think.mode ?? wrap.mode) !== 'record');
    const scripts = explicit(modules.scripts) ?? true;
    const browse = explicit(modules.browse) ?? booleanSetting(object(document.execute).browse_tool ?? wrap.browse) ?? true;
    const mcpMode = env.CAVEMAN_MCP ?? object(document.execute).mcp ?? wrap.mcp;
    const mcp = mcpMode !== 'marker-only' && booleanSetting(mcpMode) !== false;
    const memory = booleanSetting(object(document.remember).mem) ?? true;
    const configuredCore = booleanSetting(env.CAVEMAN_CORE) ?? booleanSetting(think.core ?? wrap.core) ?? explicit(modules.output) ?? true;
    const profile = env.CAVEMAN_NATIVE_PROFILE?.trim().toLowerCase() ?? '';
    const supportedProfile = NATIVE_PROFILES.has(profile);
    const configuredMode = env.CAVEMAN_NATIVE_MODE?.trim().toLowerCase();
    const proxyMode = env.CAVEMAN_WRAP_MODE ?? think.mode ?? wrap.mode ?? 'compress';
    const nativeMode = profile && !supportedProfile || profile === 'record-only'
        ? 'record'
        : configuredMode ? configuredMode === 'safe' || configuredMode === 'max' ? configuredMode : 'record'
            : proxyMode === 'record' ? 'record' : proxyMode === 'pixel' ? 'max' : 'safe';
    const nativeProfile = supportedProfile ? profile : nativeMode === 'record' ? 'record-only' : nativeMode === 'max' ? 'full-max' : 'full-safe';
    const core = configuredCore && nativeMode !== 'record' && nativeProfile !== 'record-only';
    return { input, scripts, browse, mcp, memory, core, coreLeanBuild: core && nativeProfile === 'core-lean-build', nativeMode, nativeProfile };
}
/** Modules default to on; a saved explicit off is respected. */
export function moduleEnabled(kind, env = process.env) {
    return runtimeSettings(env)[kind];
}
export function localOrigin(endpoint) {
    try {
        const url = new URL(endpoint);
        if (url.protocol !== 'http:' || url.username || url.password || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
            return undefined;
        return url;
    }
    catch {
        return undefined;
    }
}
// Use an explicit direct connection, even when the host process uses an HTTP proxy.
async function directLocalFetch(input, init) {
    const request = new Request(input, init);
    const url = localOrigin(request.url);
    if (!url)
        throw new Error('Caveman runtime must use a loopback HTTP address');
    const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
    return new Promise((resolveResponse, reject) => {
        const child = httpRequest({
            hostname: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/gu, ''),
            port: url.port || 80, path: `${url.pathname}${url.search}`, method: request.method,
            headers: Object.fromEntries(request.headers), signal: request.signal, agent: false,
        }, response => {
            try {
                const status = response.statusCode ?? 500;
                const headers = new Headers();
                for (const [name, value] of Object.entries(response.headers)) {
                    if (Array.isArray(value))
                        for (const item of value)
                            headers.append(name, item);
                    else if (value !== undefined)
                        headers.set(name, value);
                }
                const empty = status === 204 || status === 205 || status === 304;
                if (empty)
                    response.resume();
                const stream = empty ? null : Readable.toWeb(response);
                resolveResponse(new Response(stream, { status, statusText: response.statusMessage, headers }));
            }
            catch (error) {
                response.destroy();
                reject(error);
            }
        });
        child.once('error', reject);
        child.end(body);
    });
}
/** Verify that the loopback listener matches the runtime's private run-state record. */
export async function verifiedRuntime(endpoint, env = process.env, signal) {
    return Boolean(await verifiedRuntimeInstance(endpoint, cavemanHome(env), signal));
}
/** Reuse a recent health check only while the private run-state record is unchanged. */
export async function verifiedRuntimeInstance(endpoint, home, signal, cached) {
    signal?.throwIfAborted();
    const url = localOrigin(endpoint);
    if (!url)
        return undefined;
    const port = Number(url.port || 80);
    try {
        const runPath = join(home, 'run', `${port}.json`);
        const record = readFileSync(runPath, 'utf8');
        if (record === cached?.record)
            return cached;
        const state = JSON.parse(record);
        if (!state || typeof state !== 'object' || Array.isArray(state))
            return undefined;
        const run = state;
        if (run.schema !== 'caveman.proxy.run.v1' || (run.owner !== 'start' && run.owner !== 'wrap') ||
            typeof run.pid !== 'number' || run.port !== port || typeof run.instance_token !== 'string' || !run.instance_token)
            return undefined;
        const timeout = AbortSignal.timeout(750);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const health = await directLocalFetch(`${url.origin}/health/live`, { signal: combined });
        const matches = health.ok && health.headers.get('x-caveman-instance') === run.instance_token;
        await health.body?.cancel();
        return matches && readFileSync(runPath, 'utf8') === record ? { record, token: run.instance_token } : undefined;
    }
    catch {
        signal?.throwIfAborted();
        return undefined;
    }
}
/** Guard every automatic middleware call against a different or replaced listener. */
export function guardedRuntimeFetch(endpoint, env = process.env) {
    const origin = localOrigin(endpoint)?.origin;
    return async (input, init) => {
        const request = new Request(input, init);
        if (!origin || localOrigin(request.url)?.origin !== origin || !await verifiedRuntime(endpoint, env, request.signal)) {
            throw new Error('Caveman runtime is unavailable or unverified');
        }
        return directLocalFetch(request);
    };
}
