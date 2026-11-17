import type { Context } from '@deepseek-ai/cordis';
export { createSkillProvider } from './skills.js';
export declare const name = "security-audit";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
