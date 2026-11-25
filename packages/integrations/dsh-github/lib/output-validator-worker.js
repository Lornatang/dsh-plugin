import { parentPort } from 'node:worker_threads';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
const MAX_CACHED_SCHEMAS = 16;
const MAX_TASKS = 64;
const cache = new Map();
let tasks = 0;
parentPort?.on('message', (task) => {
    const { id, schemaId, schema, value } = task;
    let result;
    let retire = false;
    let cached = false;
    try {
        // The SDK's validator contract is synchronous; AJV returns a Promise for
        // asynchronous schemas, which that contract would incorrectly treat as true.
        if (schema && typeof schema === 'object' && '$async' in schema && schema.$async) {
            throw new Error('asynchronous output schemas are not supported');
        }
        let validator = schemaId === undefined ? undefined : cache.get(schemaId);
        if (!validator) {
            if (schema === undefined)
                throw new Error('output schema was not provided');
            // Use a separate AJV instance because the SDK's cache also keys by remote $id.
            validator = new AjvJsonSchemaValidator().getValidator(schema);
            if (schemaId !== undefined) {
                // Retire rather than evict: the host only omits a schema it believes
                // this worker knows, so silently dropping one would break later hits.
                if (cache.size >= MAX_CACHED_SCHEMAS)
                    retire = true;
                cache.set(schemaId, validator);
            }
        }
        cached = schemaId !== undefined;
        const checked = validator(value);
        result = checked.valid ? { valid: true } : { valid: false, error: String(checked.errorMessage ?? 'invalid output').slice(0, 1000) };
    }
    catch (error) {
        result = { valid: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'invalid output schema' };
    }
    tasks += 1;
    parentPort?.postMessage({ id, ...result, retire: retire || tasks >= MAX_TASKS, cached });
});
