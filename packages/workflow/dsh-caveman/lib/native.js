import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { cavemanSessionId } from './attribution.js';
import { verifiedRuntimeInstance } from './runtime.js';
import { isManagedTool } from './compression.js';
const profiles = new Set(['record-only', 'core', 'core-lean-build', 'ledger', 'ccr-masking', 'cache-aware', 'full-safe', 'full-max']);
const stopwords = new Set(['about', 'after', 'again', 'agent', 'before', 'build', 'change', 'code', 'could', 'create', 'does', 'from', 'have', 'help', 'implement', 'into', 'make', 'please', 'project', 'repository', 'should', 'spec', 'task', 'that', 'their', 'then', 'there', 'these', 'they', 'this', 'through', 'user', 'want', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);
/** Confirm that the model's assembled tool surface includes the admitted MCP recovery tool. */
export function recoveryIsPublished(assembly, tool) {
    const direct = assembly.tools.find(entry => entry.name === tool.name);
    if (direct && direct.description === tool.description && isDeepStrictEqual(direct.parameters, tool.parameters))
        return true;
    if (!assembly.tools.some(entry => entry.name === 'run_code'))
        return false;
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk' && section.interpolate === false)?.text ?? '';
    return (sdk.includes('declare const tools:') && sdk.split(`\n  ${tool.name}:`).length >= 3) ||
        (sdk.includes('tools: Tools') && sdk.includes(`async def ${tool.name}(`));
}
/** Hash and classify the prompt locally; the runtime does not receive the prompt text. */
export function nativePrompt(prompt) {
    const text = prompt.toLowerCase();
    const type = /\b(migrat(?:e|ion)|schema change|backfill|rollback)\b/u.test(text) ? 'migration'
        : /\b(bug|fix|broken|regression|crash|error|fails?|incorrect)\b/u.test(text) ? 'bugfix'
            : /\b(investigat(?:e|ion)|diagnos(?:e|is)|root cause|why does|trace)\b/u.test(text) ? 'investigation'
                : /\b(refactor|restructure|reorganize|cleanup|clean up)\b/u.test(text) ? 'refactor'
                    : /\b(review|audit|critique|assess)\b/u.test(text) ? 'review'
                        : /\b(verif(?:y|ication)|test only|prove|validate|check that)\b/u.test(text) ? 'verification'
                            : /\b(build|implement|add|create|ship|feature)\b/u.test(text) ? 'feature' : 'general';
    const seen = new Set();
    for (const raw of prompt.match(/[A-Za-z][A-Za-z0-9_./-]{2,63}/gu) ?? []) {
        const term = raw.toLowerCase().replace(/^[-./]+|[-./]+$/gu, '');
        if (term.length < 3 || term.length > 64 || term.includes('..') || term.startsWith('/') || stopwords.has(term) ||
            /^(?:sk|pk|rk|ghp|github_pat|xox[baprs]|akia)[-_]/iu.test(term) || /^[a-z0-9_-]{40,}$/iu.test(term))
            continue;
        seen.add(term);
        if (seen.size === 12)
            break;
    }
    const trimmed = text.trim();
    const continuation = Boolean(trimmed && trimmed.length <= 160 && trimmed.split(/\s+/u).length <= 14 &&
        /^(?:please\s+)?(?:continue|go ahead|keep going|proceed|do (?:it|that)|fix (?:it|that)|retry|try again|explain (?:it|that)|what do you mean|yes|yep|yeah|why\??|how\??)[.!?\s]*$/u.test(trimmed));
    const bytes = Buffer.from(prompt, 'utf8');
    return { prompt: { bytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }, task_profile: { type, terms: [...seen], continuation } };
}
/** Return the supported local socket endpoint, if available on this platform. */
export function nativeSocketPath(home, platform = process.platform) {
    // The current Windows runtime has no pipe peer proof, and its HTTP health
    // check only verifies the HTTP listener. Keep native events local to DSH.
    return platform === 'win32' ? undefined : join(home, 'run', 'native.sock');
}
function validResponse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const response = value;
    if (response.protocol_version !== 1 || response.fail_open !== true || !['allow', 'observe', 'block', 'ask', 'defer'].includes(String(response.action)) ||
        !['silent', 'advisory', 'user'].includes(String(response.visibility)))
        return false;
    if (response.policy_mode !== undefined && !['record', 'safe', 'max'].includes(String(response.policy_mode)))
        return false;
    if (response.profile !== undefined && !profiles.has(String(response.profile)))
        return false;
    for (const [key, maximum] of [['context', 65536], ['message', 4096], ['output_replacement', 2097152], ['recovery_ref', 1024], ['decision_id', 256]]) {
        const field = response[key];
        if (field !== undefined && (typeof field !== 'string' || Buffer.byteLength(field, 'utf8') > maximum))
            return false;
    }
    return true;
}
/** Refuse a replaced socket path before sending prompt terms or tool data over it. */
async function socketTrust(path) {
    try {
        const info = await lstat(path);
        if (!info.isSocket())
            return 'untrusted';
        return typeof process.getuid === 'function' && info.uid !== process.getuid() ? 'untrusted' : 'trusted';
    }
    catch (error) {
        // A runtime that is still starting has no socket yet. Report it as absent so the
        // caller may retry its connection, and check this path again before each retry.
        if (error.code === 'ENOENT')
            return 'missing';
        return 'untrusted';
    }
}
export async function nativeCall(home, request, signal) {
    if (signal?.aborted)
        return undefined;
    const socketPath = nativeSocketPath(home);
    if (!socketPath || await socketTrust(socketPath) === 'untrusted')
        return undefined;
    const payload = Buffer.from(JSON.stringify(request) + '\n');
    if (payload.length > 2 * 1024 * 1024)
        return undefined;
    const attempt = () => new Promise(resolveResponse => {
        let finished = false;
        let connected = false;
        let size = 0;
        const chunks = [];
        const socket = connect({ path: socketPath });
        const finish = (response, retry = false) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
            socket.destroy();
            resolveResponse({ response, retry });
        };
        const abort = () => finish();
        // The runtime enforces its own 250 ms budget. Allow transport and event-loop
        // scheduling slack, while bounding the whole request even if bytes trickle in.
        const timeout = setTimeout(() => finish(), 750);
        signal?.addEventListener('abort', abort, { once: true });
        socket.once('connect', () => { connected = true; if (!finished)
            socket.write(payload); });
        socket.on('data', (chunk) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024)
                return finish();
            chunks.push(chunk);
            if (chunk.includes(10)) {
                try {
                    const line = Buffer.concat(chunks);
                    const parsed = JSON.parse(line.subarray(0, line.indexOf(10)).toString('utf8'));
                    finish(validResponse(parsed) ? parsed : undefined);
                }
                catch {
                    finish();
                }
            }
        });
        socket.once('end', () => {
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                finish(validResponse(parsed) ? parsed : undefined);
            }
            catch {
                finish();
            }
        });
        socket.once('error', (error) => finish(undefined, !connected && ['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')));
    });
    const first = await attempt();
    if (!first.retry || signal?.aborted)
        return first.response;
    try {
        await delay(40, undefined, signal ? { signal } : undefined);
    }
    catch {
        return undefined;
    }
    if (await socketTrust(socketPath) === 'untrusted')
        return undefined;
    return (await attempt()).response;
}
async function inputState(ctx, cwd, input, signal) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return undefined;
    const values = input;
    const path = [values.path, values.file_path, values.file, values.filename].find(value => typeof value === 'string' && value.trim());
    if (typeof path !== 'string' || path.includes('\0'))
        return undefined;
    try {
        const filesystem = ctx.get('fs');
        if (!filesystem)
            return undefined;
        const absolute = resolve(cwd, path);
        const resolved = await realpath(absolute);
        const target = await filesystem.resolve(path, { cwd, signal });
        if (filesystem.processPathFromHostPath(resolved) !== filesystem.processPath(target))
            return undefined;
        // A FIFO would otherwise block this pre-execute hook; O_NONBLOCK fails fast and fstat rejects it.
        const file = await open(resolved, process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            const before = await file.stat();
            if (!before.isFile() || before.size > 8 * 1024 * 1024)
                return undefined;
            const content = await file.readFile({ signal: AbortSignal.any([signal, AbortSignal.timeout(250)]) });
            const [after, current, currentPath] = await Promise.all([file.stat(), stat(absolute), realpath(absolute)]);
            if (currentPath !== resolved || content.length !== before.size ||
                [after, current].some(info => info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size ||
                    info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs || info.mode !== before.mode))
                return undefined;
            const hash = createHash('sha256').update(resolved).update('\0').update(JSON.stringify(input)).update('\0').update(content);
            return `sha256:${hash.digest('hex')}`;
        }
        finally {
            await file.close();
        }
    }
    catch {
        return undefined;
    }
}
const RUNTIME_VERIFICATION_TTL_MS = 1_000;
const verifiedInstances = new Map();
async function runtimeInstance(endpoint, home, signal) {
    const key = `${endpoint}\u0000${home}`;
    const cached = verifiedInstances.get(key);
    const instance = await verifiedRuntimeInstance(endpoint, home, signal, cached && cached.expires > Date.now() ? cached.instance : undefined);
    if (!instance) {
        verifiedInstances.delete(key);
        return undefined;
    }
    if (instance !== cached?.instance) {
        if (verifiedInstances.size >= 32)
            verifiedInstances.delete(verifiedInstances.keys().next().value);
        verifiedInstances.set(key, { instance, expires: Date.now() + RUNTIME_VERIFICATION_TTL_MS });
    }
    return instance.token;
}
/** Add dynamic native task context when the verified local runtime is running. */
export function registerNative(ctx, endpoint, policy) {
    const home = process.env.CAVEMAN_HOME ?? join(homedir(), '.caveman');
    if (!nativeSocketPath(home))
        return;
    const sessions = new WeakMap();
    const owners = new WeakMap();
    const selections = new WeakMap();
    const pending = new Set();
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const result = await next();
        if (context.agent && context.toolSet)
            selections.set(context.agent, context.toolSet);
        return result;
    });
    ctx.on('agent/pre-step', async ({ agent, modelSelection, signal }, next) => {
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx);
        const specialized = preset === 'cavecrew-investigator' || preset === 'cavecrew-builder' || preset === 'cavecrew-reviewer';
        const existing = sessions.get(agent);
        if (existing?.queue)
            await existing.queue;
        const toolSet = selections.get(agent);
        let recovery;
        const recoveryVisible = () => recovery ??= (async () => {
            if (!toolSet)
                return false;
            const tool = ctx.tools.get('mcp__caveman__caveman_retrieve', agent, toolSet);
            if (!tool)
                return false;
            try {
                return recoveryIsPublished(await ctx.systemPrompt.assemble({ scope: agent, agent, modelSelection, toolSet, signal }), tool);
            }
            catch {
                signal.throwIfAborted();
                return false;
            }
        })();
        const hasReference = (message) => message.source.kind === 'dsh-caveman-native' &&
            message.content.some(block => block.type === 'text' && block.text.includes('ccr://'));
        const working = decision.messages.some(hasReference) && !await recoveryVisible()
            ? { ...decision, messages: decision.messages.filter(message => !hasReference(message)) } : decision;
        const contexts = [];
        for (const text of policy.core && !specialized ? existing?.contexts.splice(0) ?? [] : []) {
            if (!text.includes('ccr://') || await recoveryVisible())
                contexts.push(text);
        }
        const withContexts = () => {
            if (!contexts.length)
                return working;
            const reminder = createUserMessage({ source: { kind: 'dsh-caveman-native', form: 'notice' }, content: [{ type: 'text', text: contexts.join('\n\n') }] });
            return { ...working, messages: [...working.messages, reminder] };
        };
        const prompts = working.messages.filter(message => message.source.kind === 'user')
            .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).filter(Boolean);
        if (!prompts.length)
            return withContexts();
        const instance = await runtimeInstance(endpoint, home, signal);
        if (!instance) {
            sessions.delete(agent);
            return withContexts();
        }
        const directory = ctx.get('workingDirectory');
        const cwd = directory ? await directory.ensure(agent, signal) : agent.session.header.cwd ?? process.cwd();
        const id = cavemanSessionId(String(agent.session.id));
        const parent = agent.session.header.origin === 'subagent' && agent.session.header.parentSession
            ? cavemanSessionId(String(agent.session.header.parentSession)) : undefined;
        const session = { caveman_session_id: id, host_session_id: id, cwd, ...(parent ? { parent_session_id: parent } : {}) };
        const base = { protocol_version: 1, policy_mode: policy.mode, profile: policy.profile, agent: { id: 'dsh', surface: 'dsh' }, session,
            model: { provider: modelSelection.provider, model: modelSelection.model } };
        const current = sessions.get(agent);
        if (!current || current.instance !== instance) {
            const started = await nativeCall(home, { ...base, event: { type: 'session.start', timestamp_ms: Date.now() } }, signal);
            const childStarted = parent ? await nativeCall(home, { ...base, event: { type: 'subagent.start', timestamp_ms: Date.now() } }, signal) : undefined;
            sessions.set(agent, { instance, session, specialized, confirmed: Boolean(started || childStarted), contexts: [] });
            owners.set(agent.session, agent);
        }
        for (const prompt of prompts) {
            signal.throwIfAborted();
            const response = await nativeCall(home, { ...base, event: { type: 'prompt.submit', timestamp_ms: Date.now() }, ...nativePrompt(prompt) }, signal);
            if (!response)
                break;
            const state = sessions.get(agent);
            if (state)
                state.confirmed = true;
            if (policy.core && !specialized && response.context && (!response.context.includes('ccr://') || await recoveryVisible()))
                contexts.push(response.context);
        }
        return withContexts();
    });
    ctx.on('session/event', (session, event) => {
        const kind = event.type;
        if (kind !== 'compaction/start' && kind !== 'compaction/end')
            return;
        if (kind === 'compaction/end' && 'error' in event.data && event.data.error)
            return;
        const agent = owners.get(session);
        const state = agent && sessions.get(agent);
        if (!agent || !state)
            return;
        const task = (state.queue ?? Promise.resolve()).then(async () => {
            if (sessions.get(agent) !== state || await runtimeInstance(endpoint, home) !== state.instance)
                return;
            const response = await nativeCall(home, { protocol_version: 1, policy_mode: policy.mode, profile: policy.profile,
                agent: { id: 'dsh', surface: 'dsh' }, session: state.session,
                event: { type: kind === 'compaction/start' ? 'context.compact.before' : 'context.compact.after', timestamp_ms: Date.now() } });
            if (response)
                state.confirmed = true;
            if (kind === 'compaction/end' && response?.context)
                state.contexts.push(response.context);
        }).catch(() => { });
        state.queue = task;
        pending.add(task);
        void task.finally(() => pending.delete(task));
    });
    ctx.on('tools/execute', async (exec, next) => {
        if (!exec.agent || exec.name === 'run_code' || isManagedTool(exec.name))
            return next();
        const state = sessions.get(exec.agent);
        if (!state?.confirmed)
            return next();
        if (await runtimeInstance(endpoint, home, exec.signal) !== state.instance) {
            sessions.delete(exec.agent);
            return next();
        }
        const base = { protocol_version: 1, policy_mode: policy.mode, profile: policy.profile, agent: { id: 'dsh', surface: 'dsh' }, session: state.session };
        const beforeState = exec.name === 'read' ? await inputState(ctx, state.session.cwd, exec.arguments, exec.signal) : undefined;
        const before = await nativeCall(home, { ...base, event: { type: 'tool.before', timestamp_ms: Date.now() },
            tool: { name: exec.name, input: exec.arguments, ...(beforeState ? { input_state: beforeState } : {}) } }, exec.signal);
        const result = await next();
        if (exec.signal.aborted)
            return result;
        const recoveryContext = before?.context?.includes('ccr://') ?? false;
        let afterState;
        const textOnly = result.content.every(block => block.type === 'text') && result.content.reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0) <= 1_500_000;
        const content = textOnly ? result.content.map(block => block.type === 'text' ? block.text : '').join('\n') : '';
        // A first read needs a fingerprint for future reuse. Only attach it
        // when the same file state brackets a successful, recordable result.
        if (beforeState && content && !result.isError) {
            const observed = await inputState(ctx, state.session.cwd, exec.arguments, exec.signal);
            if (observed === beforeState)
                afterState = observed;
        }
        if (exec.signal.aborted || await runtimeInstance(endpoint, home, exec.signal) !== state.instance)
            return result;
        await nativeCall(home, { ...base, event: { type: result.isError ? 'tool.failure' : 'tool.after', timestamp_ms: Date.now() },
            tool: { name: exec.name, input: exec.arguments, ...(afterState ? { input_state: afterState } : {}), ...(content ? { output: Buffer.from(content).toString('base64') } : {}) } }, exec.signal);
        if (!policy.core || state.specialized || !before?.context || exec.signal.aborted)
            return result;
        if (recoveryContext && (!afterState || !exec.toolSet || !ctx.tools.get('mcp__caveman__caveman_retrieve', exec.agent, exec.toolSet)))
            return result;
        const reminder = createUserMessage({ source: { kind: 'dsh-caveman-native', form: 'notice' }, content: [{ type: 'text', text: before.context }] });
        return { ...result, additionalContexts: [...result.additionalContexts ?? [], reminder] };
    });
    ctx.on('agent/disposed', ({ agent }) => {
        const state = sessions.get(agent);
        if (!state)
            return;
        sessions.delete(agent);
        const task = (state.queue ?? Promise.resolve()).then(async () => {
            if (await runtimeInstance(endpoint, home) !== state.instance)
                return;
            const base = { protocol_version: 1, policy_mode: policy.mode, profile: policy.profile,
                agent: { id: 'dsh', surface: 'dsh' }, session: state.session };
            if (state.session.parent_session_id && !await nativeCall(home, { ...base, event: { type: 'subagent.stop', timestamp_ms: Date.now() } }))
                return;
            await nativeCall(home, { ...base, event: { type: 'session.end', timestamp_ms: Date.now() } });
        });
        pending.add(task);
        void task.finally(() => pending.delete(task));
    });
    ctx.effect(() => async () => { await Promise.allSettled([...pending]); }, 'dsh-caveman:native');
}
