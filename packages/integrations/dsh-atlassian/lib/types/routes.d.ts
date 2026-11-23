import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeSnapshot } from './bridge.js';
import type { BoardConfig } from './config.js';
import { type JiraBoard, type ToolBridge } from './board.js';
export declare const ROUTE_PREFIX = "/plugins/atlassian";
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
export interface EditableConnection {
    snapshot(): {
        jiraUrl: string;
        confluenceUrl: string;
        jiraCaFile: string;
        confluenceCaFile: string;
        allowInsecureHttp: boolean;
    };
    update(input: Record<string, unknown>): Promise<void>;
}
export interface PluginBridge extends ToolBridge {
    snapshot(): BridgeSnapshot;
    rawNames(): readonly string[];
    authorize(input?: Record<string, unknown>): Promise<BridgeSnapshot>;
    disconnect(): Promise<BridgeSnapshot>;
    start(): Promise<void>;
    dispose(): Promise<void>;
}
export declare function registerRoutes(web: RouteRegistrar, bridge: PluginBridge, board: JiraBoard, options: BoardConfig, connection?: EditableConnection): () => void;
