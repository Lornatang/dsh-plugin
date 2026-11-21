import type { State } from './state.ts';
/** Store only a digest, never the bearer token itself. */
export declare const sessionDigest: (token: string) => string;
export interface SessionStore {
    issue(): string | undefined;
    valid(token: string): boolean;
    /** Persist revocation before reporting logout success. */
    revoke(token: string): boolean;
    close(): void;
}
export declare function createSessionStore(path: string, state: State, ttlSeconds: number, onRevoke: (digest: string | undefined) => void): SessionStore;
