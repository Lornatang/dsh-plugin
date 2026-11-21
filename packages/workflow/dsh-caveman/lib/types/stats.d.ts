import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/** Report recorded message usage without claiming savings or unreported counts. */
export declare function sessionStats(events: readonly SessionEvent[], flags: string): string;
/** Aggregate each live or stored session once, excluding fork-inherited events. */
export declare function statsReport(ctx: Context, current: Session, flags: string, signal: AbortSignal): Promise<string>;
