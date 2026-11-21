import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session';
export declare function isManagedTool(name: string): boolean;
interface CompressionHistory {
    seq: SessionLogOffset;
    toolNames: Map<string, string>;
    managedCalls: Set<string>;
    hasMarker: boolean;
    originals: Map<string, {
        text: string;
        sourceId: string;
    }>;
    originalBytes: number;
}
/** Index immutable history once per session instead of rescanning it on every step. */
export declare class CompressionHistoryIndex {
    private readonly states;
    read(session: Session): CompressionHistory;
}
/** Resolve immutable event ancestry once per session, reusing earlier results. */
export declare function resolveOriginalResult(session: Session, event: SessionEvent<'tool/result'>): SessionEvent<'tool/result'>;
type ExpectedProjection = {
    callId: string;
    blocks: readonly {
        index: number;
        text: string;
    }[];
};
type ProjectedMessage = {
    role: string;
    toolCallId?: string;
    content: readonly {
        type: string;
        text?: string;
    }[];
};
/** Check the changed blocks on each matching tool result, including partial projections. */
export declare function projectionCoverage(expected: readonly ExpectedProjection[], messages: readonly ProjectedMessage[]): 'none' | 'incomplete' | 'complete';
/** Keep each result together while respecting middleware limits and unique segment ids. */
export declare function planCompressionBatches<T extends {
    bytes: number;
    segments: readonly {
        id: string;
    }[];
}>(items: readonly T[], byteBudget: number, maxSegments: number): T[][];
/** Install recoverable compression using the middleware protocol. */
export declare function registerCompression(ctx: Context, endpoint: string, automatic?: {
    fetch: typeof fetch;
    available: (signal: AbortSignal) => Promise<boolean>;
}): void;
export {};
