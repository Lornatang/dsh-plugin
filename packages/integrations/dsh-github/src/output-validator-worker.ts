import { parentPort } from 'node:worker_threads'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'

type Schema = Parameters<AjvJsonSchemaValidator['getValidator']>[0]
type Validator = ReturnType<AjvJsonSchemaValidator['getValidator']>

// Reuse one AJV instance and a bounded cache of compiled validators so repeated
// tool calls do not recompile schemas. The host recycles each worker after a
// fixed number of tasks, which also bounds cache and heap growth.
const MAX_CACHED_SCHEMAS = 16
const MAX_TASKS = 64
const provider = new AjvJsonSchemaValidator()
// The host assigns a stable id per schema object and resends the schema only
// while this worker has not compiled it, so warm calls skip the clone entirely.
const cache = new Map<number, Validator>()
let tasks = 0
let cached = false

parentPort?.on('message', (task: { id: number; schemaId?: number; schema?: Schema; value: unknown }) => {
  const { id, schemaId, schema, value } = task
  let result: { valid: boolean; error?: string }
  let retire = false
  cached = false
  try {
    // The SDK's validator contract is synchronous; AJV returns a Promise for
    // asynchronous schemas, which that contract would incorrectly treat as true.
    if (schema && typeof schema === 'object' && '$async' in schema && schema.$async) {
      throw new Error('asynchronous output schemas are not supported')
    }
    let validator = schemaId === undefined ? undefined : cache.get(schemaId)
    if (validator) cached = true
    else {
      if (schema === undefined) throw new Error('output schema was not provided')
      validator = provider.getValidator(schema)
      if (schemaId !== undefined) {
        // Retire rather than evict: the host only omits a schema it believes
        // this worker knows, so silently dropping one would break later hits.
        if (cache.size >= MAX_CACHED_SCHEMAS) retire = true
        cache.set(schemaId, validator)
        cached = true
      }
    }
    const checked = validator(value)
    result = checked.valid ? { valid: true } : { valid: false, error: String(checked.errorMessage ?? 'invalid output').slice(0, 1000) }
  } catch (error) {
    result = { valid: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'invalid output schema' }
  }
  tasks += 1
  parentPort?.postMessage({ id, ...result, retire: retire || tasks >= MAX_TASKS, cached })
})
