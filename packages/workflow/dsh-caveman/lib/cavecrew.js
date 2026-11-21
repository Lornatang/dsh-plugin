import { readFile } from 'node:fs/promises';
import { normalize } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { registerCavecrewGit } from './cavecrew-git.js';
export const name = 'cavecrew';
export const inject = ['tools', 'systemPrompt', 'llm'];
export const Config = z.object({
    role: z.union([z.const('investigator'), z.const('builder'), z.const('reviewer')]).required(),
});
/** Install one original Cavecrew persona and keep its agent's tools bounded. */
export async function apply(ctx, config) {
    const original = await readFile(new URL(`../vendor/caveman/agents/cavecrew-${config.role}.md`, import.meta.url), 'utf8');
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(original);
    if (!frontmatter)
        throw new Error(`dsh-caveman: missing Cavecrew metadata for ${config.role}`);
    const body = original.slice(frontmatter[0].length).trim();
    ctx.systemPrompt.section({
        name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: body, interpolate: false,
    });
    ctx.systemPrompt.section({
        name: 'deployment:persona-suffix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        text: '', interpolate: false,
    });
    const allowed = config.role === 'builder' ? ['read', 'edit'] : ['read', 'glob', 'grep', 'cavecrew_git'];
    if (config.role !== 'builder') {
        const role = config.role;
        ctx.inject(['subprocess', 'workingDirectory'], scoped => registerCavecrewGit(scoped, role));
        ctx.systemPrompt.section({
            name: 'cavecrew:git', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text: 'Use cavecrew_git for the permitted Git inspection operations. Use glob and grep for file searches; no shell is available.', interpolate: false,
        });
    }
    const permitted = new Set(allowed);
    const edited = new WeakMap();
    const editKey = (value) => {
        const normalized = normalize(value);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    };
    ctx.tools.guard(exec => {
        if (!permitted.has(exec.name))
            return `Cavecrew ${config.role} does not permit ${exec.name}.`;
        if (config.role !== 'builder' || exec.name !== 'edit')
            return undefined;
        if (!exec.agent || typeof exec.arguments !== 'object' || exec.arguments === null ||
            !('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string' || !exec.arguments.file_path.trim()) {
            return 'Cavecrew builder requires an existing file path.';
        }
        const path = editKey(exec.arguments.file_path);
        const paths = edited.get(exec.agent) ?? new Set();
        if (!paths.has(path)) {
            if (paths.size >= 2)
                return 'Cavecrew builder is limited to two file paths.';
            paths.add(path);
            edited.set(exec.agent, paths);
        }
        return undefined;
    });
    if (config.role === 'builder') {
        // The guard runs before the edit body, so refund the budget when the edit fails.
        ctx.on('tools/execute', async (exec, next) => {
            const result = await next();
            if (exec.name !== 'edit' || !exec.agent || !result.isError ||
                typeof exec.arguments !== 'object' || exec.arguments === null ||
                !('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string')
                return result;
            edited.get(exec.agent)?.delete(editKey(exec.arguments.file_path));
            return result;
        });
    }
    ctx.on('agent/created', async ({ agent }) => {
        const available = allowed.filter(tool => ctx.tools.get(tool, agent) !== undefined);
        agent.ctx.tools.restrict({ allow: available });
        const raw = process.env[`CAVECREW_${config.role.toUpperCase()}_MODEL`];
        const model = raw?.trim();
        if (model && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/u.test(model)) {
            const selected = agent.model.current();
            if (selected) {
                await ctx.llm.resolveModelInfo(selected.provider, model);
                agent.model.select({ provider: selected.provider, model });
            }
        }
        return undefined;
    });
}
