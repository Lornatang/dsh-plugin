import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeSnapshot } from './bridge.js';
export declare const ROUTE_PREFIX = "/plugins/notion";
export interface RouteRegistrar {
    register(route: {
        kind: 'prefix';
        path: string;
        auth: 'required';
        handler: (req: IncomingMessage, res: ServerResponse, peer?: {
            signal: AbortSignal;
        }) => void | Promise<void>;
    }): () => void;
}
export interface PluginBridge {
    snapshot(): BridgeSnapshot;
    authorize(): Promise<BridgeSnapshot>;
    disconnect(): Promise<BridgeSnapshot>;
}
export declare function registerRoutes(web: RouteRegistrar, bridge: PluginBridge): () => void;
