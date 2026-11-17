import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { createSkillProvider } from './skills.js'

export { createSkillProvider } from './skills.js'
export const name = 'security-audit'
export const inject = ['skills']

export function apply(ctx: Context): void {
  const root = fileURLToPath(new URL('../upstream/skills/', import.meta.url))
  ctx.skills.registerProvider(control => createSkillProvider(root, control))
}

export default { name, inject, apply }
