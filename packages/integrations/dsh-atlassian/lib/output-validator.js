import { Worker } from 'node:worker_threads';
// The SDK's validator API is synchronous. The bridge validates successful
// results against their discovered schema before they leave the bridge.
export const deferredOutputValidation = {
    getValidator() {
        return (data) => ({ valid: true, data: data, errorMessage: undefined });
    },
};
const MAX_ACTIVE = 4;
const MAX_WAITING = 8;
const MAX_LIVE = 8;
const MAX_VALIDATION_MS = 5000;
const CANCELLED = 'atlassian: output validation timed out or was cancelled';
let active = 0;
const waiting = [];
async function acquire(signal) {
    if (signal.aborted)
        throw new Error(CANCELLED);
    if (active < MAX_ACTIVE) {
        active++;
        return;
    }
    if (waiting.length >= MAX_WAITING)
        throw new Error('atlassian: too many pending output validations');
    await new Promise((resolve, reject) => {
        const waiter = {
            resume: () => { signal.removeEventListener('abort', waiter.cancel); resolve(); },
            cancel: () => {
                const index = waiting.indexOf(waiter);
                if (index >= 0)
                    waiting.splice(index, 1);
                reject(new Error(CANCELLED));
            },
        };
        waiting.push(waiter);
        signal.addEventListener('abort', waiter.cancel, { once: true });
    });
}
const live = new Set();
const idle = [];
const schemaIds = new WeakMap();
let nextSchemaId = 1;
function spawn() {
    // A retiring worker still counts until it exits. Native schema processing
    // can delay V8's response to terminate(), so do not replace it indefinitely.
    if (live.size >= MAX_LIVE)
        throw new Error('atlassian: output validation workers are unavailable');
    const worker = new Worker(new URL('./output-validator-worker.js', import.meta.url), {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    const entry = { worker, schemas: new Set() };
    live.add(entry);
    worker.on('error', () => { }); // A worker can fail after its caller has cancelled.
    worker.once('exit', () => {
        live.delete(entry);
        const index = idle.indexOf(entry);
        if (index >= 0)
            idle.splice(index, 1);
    });
    return entry;
}
function runTask(entry, schema, value, signal) {
    const { worker, schemas } = entry;
    let schemaId = schemaIds.get(schema);
    if (schemaId === undefined) {
        schemaId = nextSchemaId++;
        schemaIds.set(schema, schemaId);
    }
    const id = schemaId;
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            worker.off('message', onResult);
            worker.off('error', onError);
            worker.off('exit', onExit);
            signal.removeEventListener('abort', onAbort);
        };
        const onResult = (result) => {
            cleanup();
            if (result.cached)
                schemas.add(id);
            resolve(result);
        };
        const onError = (error) => { cleanup(); reject(error); };
        const onExit = () => onError(new Error('atlassian: output validation worker exited'));
        const onAbort = () => onError(new Error(CANCELLED));
        worker.once('message', onResult);
        worker.once('error', onError);
        worker.once('exit', onExit);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            worker.postMessage({ id, value, schema: schemas.has(id) ? undefined : schema });
        }
        catch (error) {
            cleanup();
            reject(error);
        }
    });
}
export async function validateOutput(schema, value, timeoutMs, caller) {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(Math.min(timeoutMs, MAX_VALIDATION_MS))]);
    await acquire(signal);
    let entry;
    let result;
    try {
        if (signal.aborted)
            throw new Error(CANCELLED);
        entry = idle.pop() ?? spawn();
        entry.worker.ref();
        result = await runTask(entry, schema, value, signal);
        signal.throwIfAborted();
        if (!result.valid)
            throw new Error(`atlassian: structured output does not match its schema: ${result.error ?? 'invalid output'}`);
    }
    finally {
        if (entry) {
            entry.worker.unref();
            if (result && !result.retire && !signal.aborted)
                idle.push(entry);
            else
                void entry.worker.terminate().catch(() => undefined);
        }
        const next = waiting.shift();
        if (next)
            next.resume();
        else
            active--;
    }
}
