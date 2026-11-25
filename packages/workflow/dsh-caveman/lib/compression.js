import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import { MiddlewareRuntime, recoveryToolDescription } from '@caveman-ai/sdk/middleware';
const HANDLE = /^cmw_[a-f0-9]{48}$/u;
const MARKER = /\[caveman: shortened; exact original via caveman_retrieve handle=(cmw_[a-f0-9]{48})/u;
const MINIMUM_TEXT_LENGTH = 2048;
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const ADAPTER = { id: 'dsh', version: packageVersion, framework_version: 'unknown', serialization_revision: 'dsh-session-v1' };
// DSH's supported schema subset omits numeric and regex constraints. Enforce
// those constraints in parseArgs while exposing a usable SDK declaration.
const RECOVERY_PARAMETERS = {
    type: 'object', additionalProperties: false, required: ['handle'],
    properties: { handle: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, query: { type: 'string' } },
};
function scopeFor(agent) {
    return { namespace: 'dsh-caveman', session_id: String(agent.session.id), branch_id: 'main', cache_epoch: '0' };
}
function parseArgs(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Invalid recovery arguments');
    const args = value;
    if (Object.keys(args).some(key => !['handle', 'offset', 'limit', 'query'].includes(key)) ||
        typeof args.handle !== 'string' || !HANDLE.test(args.handle) ||
        (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) ||
        (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 4 || args.limit > 262144)) ||
        (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 1024))) {
        throw new Error('Invalid recovery arguments');
    }
    return args;
}
function textBlocks(event) {
    if (event.type !== 'tool/result' || event.data.message.isError)
        return [];
    return event.data.message.content.flatMap((block, index) => block.type === 'text' ? [{ index, text: block.text }] : []);
}
export function isManagedTool(name) {
    return name === 'caveman_retrieve' || name === 'cavemem_recover' || name.startsWith('mcp__caveman__') || name.startsWith('mcp__caveman_browse__') || name.startsWith('mcp__caveman_codemode__') || name.startsWith('mcp__cavemem__') ||
        /^mcp__.+__(?:caveman_retrieve|browser_recover)$/u.test(name);
}
const MAX_ORIGINAL_ENTRIES = 64;
const MAX_ORIGINAL_BYTES = 8 * 1024 * 1024;
/** Keep recovery pages bounded; otherwise every compressed block is retained forever. */
function rememberOriginal(state, handle, value) {
    state.originals.set(handle, value);
    state.originalBytes += Buffer.byteLength(value.text, 'utf8');
    while (state.originals.size > 1 && (state.originals.size > MAX_ORIGINAL_ENTRIES || state.originalBytes > MAX_ORIGINAL_BYTES)) {
        const oldest = state.originals.keys().next().value;
        if (oldest === undefined)
            break;
        const removed = state.originals.get(oldest);
        state.originalBytes -= removed ? Buffer.byteLength(removed.text, 'utf8') : 0;
        state.originals.delete(oldest);
    }
}
/** Index immutable history once per session instead of rescanning it on every step. */
export class CompressionHistoryIndex {
    states = new WeakMap();
    read(session) {
        const end = session.seq;
        const previous = this.states.get(session);
        const state = previous && previous.seq <= end ? previous : {
            seq: 0, toolNames: new Map(), managedCalls: new Set(), hasMarker: false, originals: new Map(),
            originalBytes: 0,
        };
        for (const event of session.snapshotEvents(state.seq, end)) {
            const dispatch = event;
            if (dispatch.type === 'tool/ptc-dispatch' && typeof dispatch.data.rootCallId === 'string' &&
                typeof dispatch.data.name === 'string' && isManagedTool(dispatch.data.name))
                state.managedCalls.add(dispatch.data.rootCallId);
            if (event.type === 'assistant/message') {
                for (const block of event.data.message.content) {
                    if (block.type === 'tool-call' && !state.toolNames.has(block.id))
                        state.toolNames.set(block.id, block.name);
                }
            }
            for (const block of textBlocks(event)) {
                const handle = MARKER.exec(block.text)?.[1];
                if (!handle)
                    continue;
                state.hasMarker = true;
                if (state.originals.has(handle) || event.sourceEventSeqs?.length !== 1)
                    continue;
                const source = session.eventAt(event.sourceEventSeqs[0]);
                const original = source && textBlocks(source).find(candidate => candidate.index === block.index);
                if (source?.type === 'tool/result' && original) {
                    rememberOriginal(state, handle, { text: original.text, sourceId: `seq-${resolveOriginalResult(session, source).seq}` });
                }
            }
        }
        state.seq = end;
        this.states.set(session, state);
        return state;
    }
}
function fallbackPage(history, session, args) {
    if (args.query !== undefined)
        return undefined;
    const original = history.read(session).originals.get(args.handle);
    if (!original)
        return undefined;
    const bytes = Buffer.from(original.text, 'utf8');
    const offset = args.offset ?? 0;
    if (offset > bytes.length)
        throw new Error('Recovery offset exceeds the original length');
    if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)
        throw new Error('Recovery offset is not a UTF-8 boundary');
    let end = Math.min(offset + (args.limit ?? 262144), bytes.length);
    // A continuation byte at the end means the page would split a code point.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80)
        end--;
    const page = bytes.toString('utf8', offset, end);
    return JSON.stringify({
        schema_version: 1, handle: args.handle, source_id: original.sourceId, text: page,
        original_sha256: createHash('sha256').update(bytes).digest('hex'), total_bytes: bytes.length,
        complete: offset === 0 && end === bytes.length, kind: 'original_page', offset,
        next_offset: end === bytes.length ? null : end,
    });
}
const resultOrigins = new WeakMap();
/** Resolve immutable event ancestry once per session, reusing earlier results. */
export function resolveOriginalResult(session, event) {
    const cache = resultOrigins.get(session) ?? new WeakMap();
    resultOrigins.set(session, cache);
    const visited = [];
    let current = event;
    for (;;) {
        const known = cache.get(current);
        if (known) {
            current = known;
            break;
        }
        visited.push(current);
        const previous = (current.sourceEventSeqs ?? []).map(seq => session.eventAt(seq))
            .filter((item) => item?.type === 'tool/result');
        if (!previous.length)
            break;
        const oldest = previous.reduce((a, b) => a.seq < b.seq ? a : b);
        if (oldest.seq >= current.seq)
            break;
        current = oldest;
    }
    for (const item of visited)
        cache.set(item, current);
    return current;
}
const manifests = new WeakMap();
function manifestFor(session) {
    const generation = session.surface.contentGeneration;
    const count = session.surface.nodes.length;
    const cached = manifests.get(session);
    if (cached && cached.generation === generation && cached.count === count)
        return cached.value;
    const entries = session.surface.nodes.map(seq => {
        let event = session.eventAt(seq);
        if (event.type === 'tool/result')
            event = resolveOriginalResult(session, event);
        const data = event.type === 'user/message' ? event.data : 'message' in event.data ? event.data.message : event.data;
        return { id: `seq-${event.seq}`, sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
    });
    const value = { entries, bytes: Buffer.byteLength(JSON.stringify(entries), 'utf8') };
    manifests.set(session, { generation, count, value });
    return value;
}
function surfaceMatchesManifest(session, manifest) {
    if (session.surface.nodes.length !== manifest.length)
        return false;
    return session.surface.nodes.every((seq, index) => {
        let event = session.eventAt(seq);
        if (!event)
            return false;
        if (event.type === 'tool/result')
            event = resolveOriginalResult(session, event);
        return manifest[index]?.id === `seq-${event.seq}`;
    });
}
/** Check the changed blocks on each matching tool result, including partial projections. */
export function projectionCoverage(expected, messages) {
    const projections = expected.map(item => {
        const target = messages.find(message => message.role === 'tool' && message.toolCallId === item.callId);
        return target ? item.blocks.every(({ index, text }) => {
            const block = target.content[index];
            return block?.type === 'text' && block.text === text;
        }) : undefined;
    });
    if (projections.every(value => value === undefined))
        return 'none';
    return projections.every(value => value === true) ? 'complete' : 'incomplete';
}
/** Keep each result together while respecting middleware limits and unique segment ids. */
export function planCompressionBatches(items, byteBudget, maxSegments) {
    const batches = [];
    let batch = [];
    let bytes = 0;
    let count = 0;
    let ids = new Set();
    for (const item of items) {
        if (batch.length && (bytes + item.bytes > byteBudget || count + item.segments.length > maxSegments || item.segments.some(segment => ids.has(segment.id)))) {
            batches.push(batch);
            batch = [];
            bytes = 0;
            count = 0;
            ids = new Set();
        }
        batch.push(item);
        bytes += item.bytes;
        count += item.segments.length;
        for (const segment of item.segments)
            ids.add(segment.id);
    }
    if (batch.length)
        batches.push(batch);
    return batches;
}
/** Only shorten a result when the actual assembly exposes recovery to the model. */
function recoveryExposure(assembly, tool) {
    const direct = assembly.tools.find(entry => entry.name === tool.name);
    if (direct && direct.description === tool.description && isDeepStrictEqual(direct.parameters, tool.parameters))
        return { kind: 'direct' };
    const transport = assembly.tools.find(entry => entry.name === 'run_code');
    const section = assembly.sections.find(entry => entry.name === 'tools:sdk' && entry.interpolate === false);
    if (!transport || !section || !section.text.includes(tool.description))
        return undefined;
    const sdk = section.text;
    const typescript = /(?:^|\n)  caveman_retrieve: \{\n    handle: string;\n    offset\?: number;\n    limit\?: number;\n    query\?: string;\n  \};(?:\n|$)/u.test(sdk) &&
        /interface ToolOutputMap \{[\s\S]*?\n  caveman_retrieve: string;/u.test(sdk);
    const python = /class (\w+)\(TypedDict\):\n    handle: str\n    offset: NotRequired\[int\]\n    limit: NotRequired\[int\]\n    query: NotRequired\[str\]/u.exec(sdk);
    if (!typescript && !(python && sdk.includes(`async def caveman_retrieve(self, args: ${python[1]}) -> str:`)))
        return undefined;
    return { kind: 'program', sdk, transport };
}
/** Install recoverable compression using the middleware protocol. */
export function registerCompression(ctx, endpoint, automatic) {
    const runtime = new MiddlewareRuntime({ endpoint, mode: 'compress', ...(automatic ? { fetch: automatic.fetch } : {}) });
    const history = new CompressionHistoryIndex();
    const pending = new Map();
    function restore(session) {
        const key = String(session.id);
        const work = pending.get(key);
        if (!work || work.session !== session)
            return [];
        while (work.replacements.length) {
            const replacement = work.replacements[0];
            if (session.surface.nodes.includes(replacement.seq)) {
                session.append('tool/result', replacement.original.data, {
                    surfaceOp: { op: 'replace', startSeq: replacement.seq, endSeq: replacement.seq },
                    sourceEventSeqs: [replacement.seq, replacement.original.seq],
                });
            }
            else
                work.optimizations.set(replacement.optimization, false);
            // Retain the current item until append succeeds so idle/disposal can
            // retry a transient restoration error without stranding the projection.
            work.replacements.shift();
        }
        pending.delete(key);
        return [...work.optimizations].filter(([, applied]) => applied).map(([optimization]) => optimization);
    }
    const tool = {
        name: 'caveman_retrieve', description: `${recoveryToolDescription} Offset must be nonnegative; limit must be 4–262144 bytes; query must be at most 1024 characters.`,
        parameters: structuredClone(RECOVERY_PARAMETERS),
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(value, exec) {
            if (!exec.agent)
                throw new Error('Caveman recovery requires an agent session');
            const args = parseArgs(value);
            try {
                return JSON.stringify(await runtime.retrieve(scopeFor(exec.agent), args, exec.signal));
            }
            catch (error) {
                exec.signal.throwIfAborted();
                const fallback = fallbackPage(history, exec.agent.session, args);
                if (fallback !== undefined)
                    return fallback;
                throw error;
            }
        },
    };
    if (ctx.tools.get(tool.name)) {
        ctx.logger.warn('dsh-caveman: recovery tool name is already in use; input compression is disabled');
        runtime.close();
        return;
    }
    ctx.tools.register(tool, automatic ? {
        when: ({ agent, signal }) => history.read(agent.session).hasMarker || automatic.available(signal),
    } : undefined);
    ctx.effect(() => () => {
        try {
            for (const work of [...pending.values()])
                restore(work.session);
        }
        finally {
            runtime.close();
        }
    }, 'dsh-caveman:runtime');
    ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle' && pending.has(String(agent.session.id)))
            restore(agent.session);
    });
    ctx.on('llm/stream', (options, next) => (async function* () {
        const work = options.sessionId === undefined ? undefined : pending.get(String(options.sessionId));
        if (work) {
            const coverage = projectionCoverage(work.replacements.map(replacement => ({
                callId: replacement.original.data.message.toolCallId, blocks: replacement.sentBlocks,
            })), options.messages);
            const visible = options.tools?.find(entry => entry.name === (work.exposure.kind === 'direct' ? tool.name : 'run_code'));
            const lastSystem = options.messages.filter(message => message.role === 'system' && message.content.some(block => block.type === 'text' && block.text)).at(-1);
            const systemText = lastSystem?.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            const valid = work.exposure.kind === 'direct'
                ? visible && visible.description === tool.description && isDeepStrictEqual(visible.parameters, tool.parameters)
                : visible && isDeepStrictEqual(visible, work.exposure.transport) && systemText?.includes(work.exposure.sdk);
            const restored = restore(work.session);
            if (coverage !== 'none' && (coverage !== 'complete' || !valid)) {
                throw new Error('dsh-caveman: compressed results or their recovery tool were not available for the request');
            }
            if (coverage === 'complete')
                for (const optimization of restored)
                    runtime.report(optimization);
        }
        yield* next();
    })());
    const selections = new WeakMap();
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
        const toolSet = selections.get(agent);
        if (!toolSet || ctx.tools.get(tool.name, agent, toolSet) !== tool)
            return decision;
        const session = agent.session;
        if (pending.has(String(session.id)))
            restore(session);
        const { toolNames, managedCalls } = history.read(session);
        const eligible = [];
        for (const seq of [...session.surface.nodes]) {
            const event = session.eventAt(seq);
            if (!event || event.type !== 'tool/result')
                continue;
            const blocks = textBlocks(event).filter(block => block.text.length >= MINIMUM_TEXT_LENGTH && !MARKER.test(block.text));
            if (!blocks.length)
                continue;
            const toolName = toolNames.get(event.data.message.toolCallId);
            if (!toolName || isManagedTool(toolName) || managedCalls.has(event.data.message.toolCallId))
                continue;
            eligible.push({ seq, event, blocks });
        }
        if (!eligible.length)
            return decision;
        const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent, modelSelection, toolSet, signal });
        const exposure = recoveryExposure(assembly, tool);
        if (!exposure)
            return decision;
        const published = { name: tool.name, description: tool.description, parameters: tool.parameters };
        const scope = scopeFor(agent);
        const binding = runtime.recovery(scope);
        if (!binding)
            return decision;
        let capabilities;
        try {
            capabilities = await runtime.ready(signal);
        }
        catch {
            signal.throwIfAborted();
            return decision;
        }
        const manifest = manifestFor(session);
        const maxSegments = capabilities.limits.max_segments ?? 256;
        const byteBudget = Math.max(0, capabilities.limits.request_bytes - manifest.bytes - 16_384);
        const prepared = eligible.map(candidate => {
            const sourceId = `seq-${resolveOriginalResult(session, candidate.event).seq}`;
            const segments = candidate.blocks.map(block => ({
                id: candidate.event.data.message.content.length === 1 ? sourceId : `${sourceId}-block-${block.index}`,
                sourceId, kind: 'tool_result', content: block.text, index: block.index,
            }));
            return { ...candidate, sourceId, segments, bytes: segments.reduce((sum, segment) => sum + Buffer.byteLength(JSON.stringify(segment), 'utf8') + 256, 0) };
        });
        const batches = planCompressionBatches(prepared, byteBudget, maxSegments);
        try {
            for (const group of batches) {
                signal.throwIfAborted();
                if (!surfaceMatchesManifest(session, manifest.entries)) {
                    restore(session);
                    return decision;
                }
                const candidates = group.filter(candidate => session.surface.nodes.includes(candidate.seq));
                if (!candidates.length || ctx.tools.get(tool.name, agent, toolSet) !== tool)
                    continue;
                const segments = candidates.flatMap(candidate => candidate.segments);
                const optimization = await runtime.optimize({
                    scope, binding, adapter: ADAPTER, manifest: manifest.entries,
                    candidates: segments,
                    model: { provider: modelSelection.provider, id: modelSelection.model, protocol: 'dsh' },
                    recoveryOverheadText: JSON.stringify(published), signal,
                });
                signal.throwIfAborted();
                if (!surfaceMatchesManifest(session, manifest.entries) || ctx.tools.get(tool.name, agent, toolSet) !== tool) {
                    restore(session);
                    return decision;
                }
                if (!optimization.replacements.length)
                    continue;
                const updates = new Map();
                let invalid = false;
                for (const replacement of optimization.replacements) {
                    const candidate = candidates.find(item => item.segments.some(segment => segment.id === replacement.segment_id));
                    const segment = candidate?.segments.find(item => item.id === replacement.segment_id);
                    if (!candidate || !segment || replacement.source_id !== candidate.sourceId || !session.surface.nodes.includes(candidate.seq)) {
                        invalid = true;
                        break;
                    }
                    const changes = updates.get(candidate) ?? new Map();
                    if (changes.has(segment.index)) {
                        invalid = true;
                        break;
                    }
                    changes.set(segment.index, replacement.text);
                    updates.set(candidate, changes);
                }
                if (invalid)
                    continue;
                for (const [candidate, changes] of updates) {
                    const message = freezeMessage({
                        ...candidate.event.data.message,
                        content: candidate.event.data.message.content.map((block, index) => changes.has(index) ? { type: 'text', text: changes.get(index) } : block),
                    });
                    const replaced = session.append('tool/result', { ...candidate.event.data, message }, {
                        surfaceOp: { op: 'replace', startSeq: candidate.seq, endSeq: candidate.seq }, sourceEventSeqs: [candidate.seq],
                    });
                    const key = String(session.id);
                    const work = pending.get(key) ?? { session, exposure, replacements: [], optimizations: new Map() };
                    work.optimizations.set(optimization, true);
                    work.replacements.push({ seq: replaced.seq, original: candidate.event, optimization, sentBlocks: [...changes].map(([index, text]) => ({ index, text })) });
                    pending.set(key, work);
                }
            }
        }
        catch (error) {
            restore(session);
            throw error;
        }
        return decision;
    });
}
