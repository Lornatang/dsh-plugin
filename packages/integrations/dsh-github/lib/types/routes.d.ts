import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeSnapshot, ConnectInput } from './bridge.js';
export declare const ROUTE_PREFIX = "/plugins/github";
/** A fenced client can still trickle request bytes forever; bound the read. */
export declare const REQUEST_BODY_TIMEOUT_MS = 5000;
export interface RouteRegistrar {
    register(route: {
        kind: 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
export interface RequestFence {
    requestRejection(req: IncomingMessage): number | undefined;
}
export interface PluginBridge {
    snapshot(): BridgeSnapshot;
    connect(input: ConnectInput): Promise<BridgeSnapshot>;
    cancel(): Promise<BridgeSnapshot>;
    disconnect(): Promise<BridgeSnapshot>;
}
export declare function registerRoutes(web: RouteRegistrar, bridge: PluginBridge, fence: RequestFence | undefined): () => void;
