import z from '@deepseek-ai/schemastery';
export const DEFAULT_GITHUB_URL = 'https://api.githubcopilot.com/mcp/';
export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = 'Ov23liyuutYTU29KMjVg';
export const Config = z.object({
    serverName: z.string().default('github'),
    url: z.string().default(DEFAULT_GITHUB_URL),
    // AbortSignal.timeout rejects values above the 32-bit signed millisecond limit.
    toolCallTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(60000),
    toolsets: z.string().default('repos,issues,pull_requests,actions'),
    readOnly: z.boolean().default(false),
    credentialSource: z.union(['saved', 'env', 'gh']).default('saved'),
    oauthClientId: z.string().default(DEFAULT_GITHUB_OAUTH_CLIENT_ID),
    oauthScopes: z.string().default(''),
});
