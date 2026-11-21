import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Config } from './config.js';
import type { SessionStore } from './store.js';
export interface BridgeHost {
    register(definition: ToolDefinition): () => void;
    logger: {
        info(message: string): void;
        warn(message: string): void;
        error(message: string): void;
    };
}
export interface BridgeOptions extends Config {
    store: SessionStore;
    /** Whether the host exposes tools/pre-execute. When false, only read-only tools may register. */
    approvalHook?: boolean;
}
export type ConnectInput = {
    source: 'token';
    token: string;
} | {
    source: 'gh' | 'oauth';
};
export type BridgeStatus = 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error';
export interface BridgeSnapshot {
    status: BridgeStatus;
    toolCount: number;
    source?: 'token' | 'gh' | 'env' | 'oauth';
    error?: string;
    warning?: string;
    readOnly: boolean;
    oauthAvailable: boolean;
    requiredScopes?: string[];
    scopes?: string[];
    authorization?: {
        userCode: string;
        verificationUri: string;
    };
}
export declare function publicToolName(server: string, tool: string): string;
export declare class GithubBridge {
    #private;
    constructor(host: BridgeHost, options: BridgeOptions);
    snapshot(): BridgeSnapshot;
    requiresApproval(name: string): boolean;
    start(): Promise<void>;
    connect(input: ConnectInput): Promise<BridgeSnapshot>;
    cancel(): Promise<BridgeSnapshot>;
    disconnect(): Promise<BridgeSnapshot>;
    dispose(): Promise<void>;
}
