type Binary = 'blocks' | 'browse' | 'mcp' | 'memory';
type Module = 'scripts' | 'browse' | 'input';
/** Find a configured binary, PATH command, or the CLI's installation. */
export declare function findCavemanBinary(kind: Binary, configured?: string, env?: NodeJS.ProcessEnv): string | undefined;
/** Read the module switches and native coding policy in one configuration snapshot. */
export declare function runtimeSettings(env?: NodeJS.ProcessEnv): {
    input: boolean;
    scripts: boolean;
    browse: boolean;
    mcp: boolean;
    memory: boolean;
    core: boolean;
    coreLeanBuild: boolean;
    nativeMode: 'record' | 'safe' | 'max';
    nativeProfile: string;
};
/** Modules default to on; a saved explicit off is respected. */
export declare function moduleEnabled(kind: Module, env?: NodeJS.ProcessEnv): boolean;
/** Verify that the loopback listener matches the runtime's private run-state record. */
export declare function verifiedRuntime(endpoint: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean>;
export interface VerifiedRuntimeInstance {
    readonly record: string;
    readonly token: string;
}
/** Reuse a recent health check only while the private run-state record is unchanged. */
export declare function verifiedRuntimeInstance(endpoint: string, home: string, signal?: AbortSignal, cached?: VerifiedRuntimeInstance): Promise<VerifiedRuntimeInstance | undefined>;
/** Guard every automatic middleware call against a different or replaced listener. */
export declare function guardedRuntimeFetch(endpoint: string, env?: NodeJS.ProcessEnv): typeof fetch;
export {};
