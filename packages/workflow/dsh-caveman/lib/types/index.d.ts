import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type DefaultMode, type VoiceMode } from './mode.js';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-caveman-mode': {
            kind: 'dsh-caveman-mode';
            form: 'instructions';
            mode: VoiceMode;
        };
        'dsh-caveman-stats': {
            kind: 'dsh-caveman-stats';
            form: 'notice';
        };
    }
}
export declare const name = "caveman";
export declare const inject: string[];
export interface Config {
    defaultMode?: DefaultMode;
    inputCompression?: boolean;
    middlewareEndpoint?: string;
    blocksBinary?: string;
    browseBinary?: string;
    mcpBinary?: string;
    memoryBinary?: string;
    codeMode?: false | {
        config: string;
        workspace: string;
    };
}
export declare const Config: z<Config>;
/** Register skills and reinforce the selected mode per session. */
export declare function apply(ctx: Context, config?: Config): void;
