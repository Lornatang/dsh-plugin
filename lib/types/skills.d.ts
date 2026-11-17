import type { SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill';
/** Expose the security-audit skill and its companion files to DSH. */
export declare function createSkillProvider(root: string, control?: SkillProviderControl): SkillProvider;
