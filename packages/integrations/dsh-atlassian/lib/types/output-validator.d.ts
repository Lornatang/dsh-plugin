import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types';
export declare const deferredOutputValidation: jsonSchemaValidator;
export declare function validateOutput(schema: object, value: unknown, timeoutMs: number, caller: AbortSignal): Promise<void>;
