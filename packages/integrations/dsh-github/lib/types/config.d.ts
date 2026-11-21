import z from '@deepseek-ai/schemastery';
export declare const DEFAULT_GITHUB_URL = "https://api.githubcopilot.com/mcp/";
export declare const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Ov23liyuutYTU29KMjVg";
export interface Config {
    serverName: string;
    url: string;
    toolCallTimeoutMs: number;
    toolsets: string;
    readOnly: boolean;
    credentialSource: 'saved' | 'env' | 'gh';
    oauthClientId: string;
    oauthScopes: string;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    serverName: z<string, string, "defined">;
    url: z<string, string, "defined">;
    toolCallTimeoutMs: z<number, number, "defined">;
    toolsets: z<string, string, "defined">;
    readOnly: z<boolean, boolean, "defined">;
    credentialSource: z<"saved" | "env" | "gh", "saved" | "env" | "gh", "defined">;
    oauthClientId: z<string, string, "defined">;
    oauthScopes: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    serverName: z<string, string, "defined">;
    url: z<string, string, "defined">;
    toolCallTimeoutMs: z<number, number, "defined">;
    toolsets: z<string, string, "defined">;
    readOnly: z<boolean, boolean, "defined">;
    credentialSource: z<"saved" | "env" | "gh", "saved" | "env" | "gh", "defined">;
    oauthClientId: z<string, string, "defined">;
    oauthScopes: z<string, string, "defined">;
}>>, "plain">;
