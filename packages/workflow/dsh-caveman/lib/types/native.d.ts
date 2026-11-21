import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-caveman-native': {
            kind: 'dsh-caveman-native';
            form: 'notice';
        };
    }
}
type PolicyMode = 'record' | 'safe' | 'max';
interface NativeResponse {
    protocol_version: 1;
    action: string;
    visibility: string;
    fail_open: true;
    context?: string;
}
/** Confirm that the model's assembled tool surface includes the admitted MCP recovery tool. */
export declare function recoveryIsPublished(assembly: Pick<PromptAssembly, 'tools' | 'sections'>, tool: ToolDefinition): boolean;
/** Hash and classify the prompt locally; the runtime does not receive the prompt text. */
export declare function nativePrompt(prompt: string): {
    prompt: {
        bytes: number;
        sha256: string;
    };
    task_profile: {
        type: string;
        terms: string[];
        continuation: boolean;
    };
};
/** Return the supported local socket endpoint, if available on this platform. */
export declare function nativeSocketPath(home: string, platform?: NodeJS.Platform): string | undefined;
export declare function nativeCall(home: string, request: object, signal?: AbortSignal): Promise<NativeResponse | undefined>;
/** Add dynamic native task context when the verified local runtime is running. */
export declare function registerNative(ctx: Context, endpoint: string, policy: {
    mode: PolicyMode;
    profile: string;
    core: boolean;
}): void;
export {};
