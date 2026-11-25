import type { Context } from '@deepseek-ai/cordis';
export declare function cavemanSessionId(sessionId: string): string;
export declare function cavemanRequestHeaders(endpoint: string, request: {
    baseURL: string;
    sessionId?: string;
}, headers: Headers): Headers;
export declare function registerAttribution(ctx: Context, endpoint: string): void;
