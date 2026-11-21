import { Worker } from 'node:worker_threads'
import type { jsonSchemaValidator, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types'

// The SDK's validator API is synchronous. The bridge validates successful
// results against their discovered schema before they leave the bridge.
export const deferredOutputValidation: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (data: unknown) => ({ valid: true, data: data as T, errorMessage: undefined })
  },
}

const MAX_ACTIVE = 4
const MAX_WAITING = 8
const MAX_LIVE = 8
const MAX_VALIDATION_MS = 5000
const CANCELLED = 'atlassian: output validation timed out or was cancelled'

let active = 0
type Waiter = { resume: () => void; cancel: () => void }
const waiting: Waiter[] = []

async function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error(CANCELLED)
  if (active < MAX_ACTIVE) { active++; return }
  if (waiting.length >= MAX_WAITING) throw new Error('atlassian: too many pending output validations')
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resume: () => { signal.removeEventListener('abort', waiter.cancel); resolve() },
      cancel: () => {
        const index = waiting.indexOf(waiter)
        if (index >= 0) waiting.splice(index, 1)
        reject(new Error(CANCELLED))
      },
    }
    waiting.push(waiter)
    signal.addEventListener('abort', waiter.cancel, { once: true })
  })
}

interface Entry { worker: Worker; schemas: Set<number> }
interface Result { valid: boolean; error?: string; cached?: boolean; retire?: boolean }
const live = new Set<Entry>()
const idle: Entry[] = []
const schemaIds = new WeakMap<object, number>()
let nextSchemaId = 1

function spawn(): Entry {
  // A retiring worker still counts until it exits. Native schema processing
  // can delay V8's response to terminate(), so do not replace it indefinitely.
  if (live.size >= MAX_LIVE) throw new Error('atlassian: output validation workers are unavailable')
  const worker = new Worker(new URL('./output-validator-worker.js', import.meta.url), {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  })
  const entry: Entry = { worker, schemas: new Set() }
  live.add(entry)
  worker.on('error', () => {}) // A worker can fail after its caller has cancelled.
  worker.once('exit', () => {
    live.delete(entry)
    const index = idle.indexOf(entry)
    if (index >= 0) idle.splice(index, 1)
  })
  return entry
}

function runTask(entry: Entry, schema: object, value: unknown, signal: AbortSignal): Promise<Result> {
  const { worker, schemas } = entry
  let schemaId = schemaIds.get(schema)
  if (schemaId === undefined) { schemaId = nextSchemaId++; schemaIds.set(schema, schemaId) }
  const id = schemaId
  return new Promise<Result>((resolve, reject) => {
    const cleanup = (): void => {
      worker.off('message', onResult)
      worker.off('error', onError)
      worker.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
    }
    const onResult = (result: Result): void => {
      cleanup()
      if (result.cached) schemas.add(id)
      resolve(result)
    }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onExit = (): void => onError(new Error('atlassian: output validation worker exited'))
    const onAbort = (): void => onError(new Error(CANCELLED))
    worker.once('message', onResult)
    worker.once('error', onError)
    worker.once('exit', onExit)
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    try { worker.postMessage({ id, value, schema: schemas.has(id) ? undefined : schema }) }
    catch (error) { cleanup(); reject(error) }
  })
}

export async function validateOutput(schema: object, value: unknown, timeoutMs: number, caller: AbortSignal): Promise<void> {
  const signal = AbortSignal.any([caller, AbortSignal.timeout(Math.min(timeoutMs, MAX_VALIDATION_MS))])
  await acquire(signal)
  let entry: Entry | undefined
  let result: Result | undefined
  try {
    if (signal.aborted) throw new Error(CANCELLED)
    entry = idle.pop() ?? spawn()
    entry.worker.ref()
    result = await runTask(entry, schema, value, signal)
    signal.throwIfAborted()
    if (!result.valid) throw new Error(`atlassian: structured output does not match its schema: ${result.error ?? 'invalid output'}`)
  } finally {
    if (entry) {
      entry.worker.unref()
      if (result && !result.retire && !signal.aborted) idle.push(entry)
      else void entry.worker.terminate().catch(() => undefined)
    }
    const next = waiting.shift()
    if (next) next.resume()
    else active--
  }
}
