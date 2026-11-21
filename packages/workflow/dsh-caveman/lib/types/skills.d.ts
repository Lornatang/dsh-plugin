import type { SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill';
/** Expose skills through the DSH provider registry. */
export declare function createSkillProvider(root: string, control?: SkillProviderControl): SkillProvider;
