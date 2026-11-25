import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { loadSkills } from './skills.js'

export const name = 'superpowers'
export const inject = ['skills', 'systemPrompt']

const platform = `### DeepSeek Harness tool mapping

- Load skills with the native \`skill\` tool, for example \`skill({"name":"brainstorming"})\`. Remove the \`superpowers:\` prefix from upstream skill references. The skill result gives a base directory for its scripts, prompts, and references. Resolve their paths from that directory, and run project scripts with the working directory specified by the skill.
- Use \`todo_write\` for checklists and \`ask_user_question\` for questions when available. Use the tools exposed by the current profile for file edits, shell commands, and plan mode.
- For worktree isolation, use \`enter_worktree\` when available. For delegation, use the available \`subagent\` and subagent control tools with their actual schemas. Give fresh workers the task prompt and resource paths. If delegation is unavailable, use the upstream inline workflow when it applies.
- For diagnostics, use DSH session tools and the configured profile's session storage to identify the requested transcript. Follow the upstream redaction and user-review workflow before sharing any diagnostics.

Apply these mappings wherever a skill refers to another harness's tools. Follow the active profile's permissions and the user's instructions.`

/** Install the upstream skills and keep the SessionStart guidance in the controller's prompt. */
export function apply(ctx: Context): void {
  const root = fileURLToPath(new URL('../vendor/superpowers/skills/', import.meta.url))
  const bundle = loadSkills(root)
  const bootstrap = `<EXTREMELY_IMPORTANT>
You have superpowers.

**Below is the full content of the using-superpowers skill. For all other skills, use the DSH skill tool.**

${bundle.introduction}

${platform}
</EXTREMELY_IMPORTANT>`

  ctx.skills.registerProvider(() => bundle.provider)
  ctx.systemPrompt.section({
    name: 'superpowers:bootstrap',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 20,
    interpolate: false,
    text: ({ agent }) => agent?.session.header.origin === 'subagent' ? '' : bootstrap,
  })
}
