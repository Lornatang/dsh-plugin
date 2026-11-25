import type { Session } from '@deepseek-ai/dsh-session';
export type VoiceMode = 'off' | 'caveman' | 'ultracave' | 'megacave';
export type DefaultMode = VoiceMode | 'manual';
export type ModeAction = 'none' | 'change' | 'status' | 'one-shot' | 'unresolved';
interface InputMessage {
    readonly source: {
        readonly kind: string;
    };
    readonly content: readonly {
        readonly type: string;
        readonly text?: string;
    }[];
}
interface InputEvent {
    readonly type: string;
    readonly data: unknown;
}
export declare const getReinforce: (startDir?: string) => boolean;
/** A profile override wins; otherwise follow environment and file resolution. */
export declare function defaultModeFor(configured: DefaultMode | undefined, cwd?: string): DefaultMode;
/** Replay only user-authored messages, then evaluate the incoming batch. */
export declare function resolveMode(configured: DefaultMode, events: readonly InputEvent[], pending: readonly InputMessage[]): {
    mode: VoiceMode;
    action: ModeAction;
};
/** Incrementally replay immutable session logs; pending messages are never cached. */
export declare class SessionModeTracker {
    private readonly states;
    resolve(configured: DefaultMode, session: Session, pending: readonly InputMessage[]): {
        mode: VoiceMode;
        action: ModeAction;
        hasRules: boolean;
    };
}
export {};
