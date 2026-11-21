import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "cavecrew";
export declare const inject: string[];
export interface Config {
    role: 'investigator' | 'builder' | 'reviewer';
}
export declare const Config: z<Config>;
/** Install one original Cavecrew persona and keep its agent's tools bounded. */
export declare function apply(ctx: Context, config: Config): Promise<void>;
