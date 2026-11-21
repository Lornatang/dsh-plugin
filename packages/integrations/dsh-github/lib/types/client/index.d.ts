import * as React from 'react';
interface ClientContext {
    slots: {
        inject(name: string, callback: () => unknown): () => void;
        register(options: Record<string, unknown>, component: React.ComponentType<never>): unknown;
    };
}
export declare function GithubSettings(): React.ReactElement;
export declare const name = "@lornatang/dsh-github";
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export {};
