import { Worker } from 'node:worker_threads'
import type { jsonSchemaValidator, JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types'

// The SDK validator API is synchronous, so validate structured results in workers.
export const deferredOutputValidation: jsonSchemaValidator = {
  getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
    return (data: unknown) => ({ valid: true, data: data as T, errorMessage: undefined })
  },
}

const MAX_WORKERS = 4
const MAX_WAITERS = 32
// Bound cleanup waits and abandoned workers in case validation stalls terminate().
const TERMINATE_GRACE_MS = 1000
const MAX_ABANDONED = 8

let slots = 0
type Waiter = { signal: AbortSignal; resolve: () => void; abort: () => void }
const waiting: Waiter[] = []

async function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('github: output validation timed out or was cancelled')
  if (slots < MAX_WORKERS) { slots++; return }
  if (waiting.length >= MAX_WAITERS) throw new Error('github: too many pending output validations')
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { signal, resolve, abort: () => {
      const index = waiting.indexOf(waiter)
      if (index !== -1) waiting.splice(index, 1)
      reject(new Error('github: output validation timed out or was cancelled'))
    } }
    waiting.push(waiter)
    signal.addEventListener('abort', waiter.abort, { once: true })
    if (signal.aborted) waiter.abort()
  })
}

function release(): void {
  const next = waiting.shift()
  if (!next) { slots--; return }
  next.signal.removeEventListener('abort', next.abort)
  next.resolve()
}

// Stable schema IDs let warm workers reuse compiled validators without cloning schemas.
const schemaIds = new WeakMap<object, number>()
let nextSchemaId = 1
function schemaIdOf(schema: unknown): number | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const known = schemaIds.get(schema)
  if (known !== undefined) return known
  const id = nextSchemaId++
  schemaIds.set(schema, id)
  return id
}

interface PooledWorker { worker: Worker; retire: boolean; schemas: Set<number> }
const idle: PooledWorker[] = []
let nextTaskId = 1
const abandoned = new Set<Worker>()

function spawnWorker(): PooledWorker {
  const worker = new Worker(new URL('./output-validator-worker.js', import.meta.url), {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  })
  // Idle or stuck workers must never keep the host process alive.
  worker.unref()
  // Resource-limit errors can arrive after task listeners are removed.
  worker.on('error', () => {})
  return { worker, retire: false, schemas: new Set() }
}

async function retireWorker(entry: PooledWorker): Promise<void> {
  const { worker } = entry
  abandoned.add(worker)
  const forget = (): void => { abandoned.delete(worker) }
  const termination = worker.terminate().then(forget, forget)
  let grace: NodeJS.Timeout | undefined
  const expired = new Promise<void>((resolve) => { grace = setTimeout(resolve, TERMINATE_GRACE_MS); grace.unref() })
  await Promise.race([termination, expired])
  if (grace) clearTimeout(grace)
}

class InvalidOutput extends Error {}

function runTask(entry: PooledWorker, schema: unknown, schemaId: number | undefined, value: unknown, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = nextTaskId++
    const { worker } = entry
    const cleanup = (): void => {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
    }
    const onMessage = (message: { id?: number; valid?: boolean; error?: string; retire?: boolean; cached?: boolean }): void => {
      if (message.id !== id) return
      entry.retire = message.retire === true
      // Record the schema only after the worker confirms it compiled it: a
      // rejected schema must keep arriving with the next task.
      if (message.cached === true && schemaId !== undefined) entry.schemas.add(schemaId)
      cleanup()
      if (message.valid) resolve()
      else reject(new InvalidOutput(message.error ?? 'invalid output'))
    }
    const onError = (error: Error): void => { cleanup(); reject(new Error('github: output validation worker failed', { cause: error })) }
    const onExit = (): void => { cleanup(); reject(new Error('github: output validation worker exited unexpectedly')) }
    const onAbort = (): void => { cleanup(); reject(new Error('github: output validation timed out or was cancelled')) }
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    const missing = schemaId === undefined || !entry.schemas.has(schemaId)
    try { worker.postMessage(missing ? { id, schemaId, schema, value } : { id, schemaId, value }) } catch (error) {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function validateOutput(schema: unknown, value: unknown, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (abandoned.size >= MAX_ABANDONED) throw new Error('github: output validation is unavailable; previous validators did not stop')
  // Queue wait is bounded separately, so the validation timeout measures only
  // worker work; a queued caller is still released by its cancellation signal.
  const queueTimeout = AbortSignal.timeout(Math.min(timeoutMs, 5000))
  const queueSignal = signal ? AbortSignal.any([signal, queueTimeout]) : queueTimeout
  await acquire(queueSignal)
  const timeout = AbortSignal.timeout(Math.min(timeoutMs, 5000))
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let entry: PooledWorker | undefined
  let healthy = false
  try {
    if (combined.aborted) throw new Error('github: output validation timed out or was cancelled')
    entry = idle.pop() ?? spawnWorker()
    try {
      await runTask(entry, schema, schemaIdOf(schema), value, combined)
      healthy = true
    } catch (error) {
      if (error instanceof InvalidOutput) {
        // The worker is healthy; only the data failed validation. Keep it pooled.
        healthy = true
        throw new Error(`github: structured output does not match its schema: ${error.message}`)
      }
      throw error
    }
  } finally {
    const keep = entry !== undefined && healthy && !entry.retire
    if (entry && keep) idle.push(entry)
    // Release the slot before waiting for worker termination.
    release()
    if (entry && !keep) await retireWorker(entry)
  }
}
