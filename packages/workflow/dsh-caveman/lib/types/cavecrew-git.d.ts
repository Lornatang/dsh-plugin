import type { Context } from '@deepseek-ai/cordis';
type ReadOnlyRole = 'investigator' | 'reviewer';
/** Provide the read-only Git operations used by the two inspection roles. */
export declare function registerCavecrewGit(ctx: Context, role: ReadOnlyRole): void;
export {};
