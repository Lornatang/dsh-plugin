/**
 * Structural view of the harness Web service and authentication entry event.
 */
import type { Context } from '@deepseek-ai/cordis';
/** Minimal surface of the harness web server used by the gate. */
export interface WebServerView {
    /** Host the harness listener is bound to, when the host service exposes it. */
    config?: {
        host?: unknown;
    };
    /** Origin the harness listener is reachable on, for example http://127.0.0.1:3080. */
    getOrigin(): string;
    /** Register an index.html transform; the returned function unregisters it. */
    tapIndex(transform: (html: string) => string): () => void;
}
interface WebEntryUrl {
    label: string;
    url: string;
    open: boolean;
}
/** Profile location reported by the harness loader. */
export interface ProfileContextView {
    /** Absolute path of the profile patch file the plugin was loaded from. */
    patchPath?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer: WebServerView;
        profileContext?: ProfileContextView;
    }
    interface Events {
        'webserver/entry-url'(this: WebServerView, baseUrl: string, entries: WebEntryUrl[]): void;
    }
}
/** Collect an entry from the host's authentication provider for each exchange. */
export declare function resolveLaunchUrl(ctx: Context, baseUrl: string): URL;
/** Logger subset used by the gate; lines are written to stderr. */
export interface LogSink {
    info(message: string): void;
    warn(message: string): void;
}
/**
 * Report startup lines on stderr, which is the only channel a headless web
 * profile leaves visible: the harness routes ctx.logger to its own exporters,
 * and the web profile installs none of them, so a generated password or a
 * listen address logged there would never reach the operator.
 */
export declare function resolveLogger(): LogSink;
export {};
