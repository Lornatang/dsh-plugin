export interface StoredSession {
    version: 1;
    source?: 'token' | 'gh' | 'oauth';
    token?: string;
    oauthClientId?: string;
    oauthRefreshToken?: string;
    oauthExpiresAt?: number;
    oauthScopes?: string[];
}
/** Keep credentials separate for each DSH profile and server. */
export declare function sessionFileFor(serverName: string, url: string, patchPath?: string): string;
/** Serialize state changes and replace the file only after a complete write. */
export declare class SessionStore {
    #private;
    constructor(file: string);
    get file(): string;
    get current(): StoredSession;
    load(): Promise<StoredSession>;
    patch(patch: Partial<StoredSession>, active?: () => boolean): Promise<void>;
    destroy(): Promise<void>;
}
