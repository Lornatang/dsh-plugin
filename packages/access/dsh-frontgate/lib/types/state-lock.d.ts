import { DatabaseSync } from 'node:sqlite';
/** Create or open a regular per-profile SQLite file with private POSIX permissions. */
export declare function openProfileDatabase(path: string): DatabaseSync;
/**
 * SQLite releases this dedicated database's OS lock when the process exits.
 * Use a local filesystem with working SQLite file locking for shared profiles.
 */
export declare function acquireStateLock(statePath: string): () => void;
