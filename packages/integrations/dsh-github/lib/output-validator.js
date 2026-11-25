import { Worker } from 'node:worker_threads';
// The SDK validator API is synchronous, so validate structured results in workers.
export const deferredOutputValidation = {
    getValidator(_schema) {
        return (data) => ({ valid: true, data: data, errorMessage: undefined });
    },
};
const MAX_WORKERS = 4;
const MAX_WAITERS = 32;
// Bound cleanup waits and abandoned workers in case validation stalls terminate().
const TERMINATE_GRACE_MS = 1000;
const MAX_ABANDONED = 8;
let slots = 0;
const waiting = [];
async function acquire(signal) {
    if (signal.aborted)
        throw new Error('github: output validation timed out or was cancelled');
    if (slots < MAX_WORKERS) {
        slots++;
        return;
    }
    if (waiting.length >= MAX_WAITERS)
        throw new Error('github: too many pending output validations');
    await new Promise((resolve, reject) => {
        const waiter = { signal, resolve, abort: () => {
                const index = waiting.indexOf(waiter);
                if (index !== -1)
                    waiting.splice(index, 1);
                reject(new Error('github: output validation timed out or was cancelled'));
            } };
        waiting.push(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
        if (signal.aborted)
            waiter.abort();
    });
}
function release() {
    const next = waiting.shift();
    if (!next) {
        slots--;
        return;
    }
    next.signal.removeEventListener('abort', next.abort);
    next.resolve();
}
// Stable schema IDs let warm workers reuse compiled validators without cloning schemas.
const schemaIds = new WeakMap();
let nextSchemaId = 1;
function schemaIdOf(schema) {
    if (typeof schema !== 'object' || schema === null)
        return undefined;
    const known = schemaIds.get(schema);
    if (known !== undefined)
        return known;
    const id = nextSchemaId++;
    schemaIds.set(schema, id);
    return id;
}
const idle = [];
let nextTaskId = 1;
const abandoned = new Set();
function spawnWorker() {
    const worker = new Worker(new URL('./output-validator-worker.js', import.meta.url), {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    // Idle or stuck workers must never keep the host process alive.
    worker.unref();
    // Resource-limit errors can arrive after task listeners are removed.
    worker.on('error', () => { });
    return { worker, retire: false, schemas: new Set() };
}
async function retireWorker(entry) {
    const { worker } = entry;
    abandoned.add(worker);
    const forget = () => { abandoned.delete(worker); };
    const termination = worker.terminate().then(forget, forget);
    let grace;
    const expired = new Promise((resolve) => { grace = setTimeout(resolve, TERMINATE_GRACE_MS); grace.unref(); });
    await Promise.race([termination, expired]);
    if (grace)
        clearTimeout(grace);
}
class InvalidOutput extends Error {
}
function runTask(entry, schema, schemaId, value, signal) {
    return new Promise((resolve, reject) => {
        const id = nextTaskId++;
        const { worker } = entry;
        const cleanup = () => {
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
            signal.removeEventListener('abort', onAbort);
        };
        const onMessage = (message) => {
            if (message.id !== id)
                return;
            entry.retire = message.retire === true;
            // Record the schema only after the worker confirms it compiled it: a
            // rejected schema must keep arriving with the next task.
            if (message.cached === true && schemaId !== undefined)
                entry.schemas.add(schemaId);
            cleanup();
            if (message.valid)
                resolve();
            else
                reject(new InvalidOutput(message.error ?? 'invalid output'));
        };
        const onError = (error) => { cleanup(); reject(new Error('github: output validation worker failed', { cause: error })); };
        const onExit = () => { cleanup(); reject(new Error('github: output validation worker exited unexpectedly')); };
        const onAbort = () => { cleanup(); reject(new Error('github: output validation timed out or was cancelled')); };
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        const missing = schemaId === undefined || !entry.schemas.has(schemaId);
        try {
            worker.postMessage(missing ? { id, schemaId, schema, value } : { id, schemaId, value });
        }
        catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
export async function validateOutput(schema, value, timeoutMs, signal) {
    if (abandoned.size >= MAX_ABANDONED)
        throw new Error('github: output validation is unavailable; previous validators did not stop');
    // Queue wait is bounded separately, so the validation timeout measures only
    // worker work; a queued caller is still released by its cancellation signal.
    const queueTimeout = AbortSignal.timeout(Math.min(timeoutMs, 5000));
    const queueSignal = signal ? AbortSignal.any([signal, queueTimeout]) : queueTimeout;
    await acquire(queueSignal);
    const timeout = AbortSignal.timeout(Math.min(timeoutMs, 5000));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let entry;
    let healthy = false;
    try {
        if (combined.aborted)
            throw new Error('github: output validation timed out or was cancelled');
        entry = idle.pop() ?? spawnWorker();
        try {
            await runTask(entry, schema, schemaIdOf(schema), value, combined);
            healthy = true;
        }
        catch (error) {
            if (error instanceof InvalidOutput) {
                // The worker is healthy; only the data failed validation. Keep it pooled.
                healthy = true;
                throw new Error(`github: structured output does not match its schema: ${error.message}`);
            }
            throw error;
        }
    }
    finally {
        const keep = entry !== undefined && healthy && !entry.retire;
        if (entry && keep)
            idle.push(entry);
        // Release the slot before waiting for worker termination.
        release();
        if (entry && !keep)
            await retireWorker(entry);
    }
}
