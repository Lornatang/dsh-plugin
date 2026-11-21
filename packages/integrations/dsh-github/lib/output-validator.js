import { Worker } from 'node:worker_threads';
// The SDK validator API is synchronous. Defer its schema validation to our
// worker pool, which is invoked for every tool page before a result reaches DSH.
export const deferredOutputValidation = {
    getValidator(_schema) {
        return (data) => ({ valid: true, data: data, errorMessage: undefined });
    },
};
const MAX_WORKERS = 4;
const MAX_WAITERS = 32;
// A validator stuck in pathological schema work (for example catastrophic regex
// backtracking) may ignore terminate() for a long time. Never let cleanup hold a
// validation slot, and cap abandoned workers so they cannot accumulate unbounded.
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
        const waiter = { signal, resolve, reject, abort: () => {
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
// Schema objects are stable for the lifetime of a discovered tool. A numeric id
// lets warm workers reuse a compiled validator without re-sending (and having
// V8 re-clone) the schema on every call.
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
let spawned = 0;
let nextTaskId = 1;
const abandoned = new Set();
function spawnWorker() {
    const worker = new Worker(new URL('./output-validator-worker.js', import.meta.url), {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    // Idle or stuck workers must never keep the host process alive.
    worker.unref();
    // A resource-limit kill (for example an OOM driven by an attacker-supplied
    // schema) fires 'error' even after the task listeners are removed. Keep a
    // permanent no-op listener so an abandoned worker can never crash the host.
    worker.on('error', () => { });
    spawned += 1;
    return { worker, retire: false, schemas: new Set() };
}
async function retireWorker(entry) {
    spawned -= 1;
    const { worker } = entry;
    abandoned.add(worker);
    const termination = worker.terminate().then(() => { abandoned.delete(worker); }, () => { abandoned.delete(worker); });
    let grace;
    const expired = new Promise((resolve) => { grace = setTimeout(resolve, TERMINATE_GRACE_MS); grace.unref(); });
    await Promise.race([termination, expired]);
    if (grace)
        clearTimeout(grace);
    // A worker that outlived the grace period stays unref'd and resource-limited;
    // it is removed from the abandoned set whenever terminate() finally settles.
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
        // Send the schema only when this worker has not compiled it yet.
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
        // Release the slot before any retirement wait: cleanup must never hold a
        // validation slot while a stuck worker ignores terminate().
        release();
        if (entry && !keep)
            await retireWorker(entry);
    }
}
