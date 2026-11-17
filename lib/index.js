import { fileURLToPath } from 'node:url';
import { createSkillProvider } from './skills.js';
export { createSkillProvider } from './skills.js';
export const name = 'security-audit';
export const inject = ['skills'];
export function apply(ctx) {
    const root = fileURLToPath(new URL('../skills/', import.meta.url));
    ctx.skills.registerProvider(control => createSkillProvider(root, control));
}
export default { name, inject, apply };
