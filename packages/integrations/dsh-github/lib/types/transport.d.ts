import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
/** Keep credentials on the configured origin and never follow redirects implicitly. */
export declare function createGithubFetch(server: URL, token: string | (() => Promise<string>), toolsets: string, readOnly: boolean, options?: {
    onLimit?: () => void;
    onEvent?: () => void;
    onInsufficientScope?: (scope: string) => string | undefined;
}): FetchLike;
