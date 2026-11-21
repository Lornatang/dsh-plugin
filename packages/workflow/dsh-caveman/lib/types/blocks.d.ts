import type { Context } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-caveman-blocks': {
            kind: 'dsh-caveman-blocks';
            form: 'notice';
            summary: string;
        };
    }
}
/** Invoke the generic Blocks hook before shell dispatch; never change the command. */
export declare function registerBlocks(ctx: Context, binary: string): void;
