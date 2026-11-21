import { parentPort } from 'node:worker_threads';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
const MAX_SCHEMAS = 16;
const MAX_TASKS = 64;
const cache = new Map();
let tasks = 0;
parentPort?.on('message', ({ id, schema, value }) => {
    let valid = false;
    let error;
    try {
        let validator = cache.get(id);
        if (!validator) {
            if (!schema || ('$async' in schema && schema.$async))
                throw new Error('expected a synchronous output schema');
            // AJV also caches by remote $id. Compile new schema identities independently.
            validator = new AjvJsonSchemaValidator().getValidator(schema);
            cache.set(id, validator);
        }
        const result = validator(value);
        valid = result.valid;
        error = result.errorMessage;
    }
    catch (failure) {
        error = failure instanceof Error ? failure.message : 'invalid output schema';
    }
    tasks++;
    parentPort?.postMessage({ valid, error: error?.slice(0, 1000), cached: cache.has(id), retire: cache.size >= MAX_SCHEMAS || tasks >= MAX_TASKS });
});
