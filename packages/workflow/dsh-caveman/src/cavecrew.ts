import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerCavecrewGit } from './cavecrew-git.js'

export const name = 'cavecrew'
export const inject = ['tools', 'systemPrompt', 'llm']
export interface Config { role: 'investigator' | 'builder' | 'reviewer' }
export const Config: z<Config> = z.object({
  role: z.union([z.const('investigator'), z.const('builder'), z.const('reviewer')]).required(),
})

interface EditTargetState {
  pending: number
  committed: boolean
}

interface EditAttempt {
  targets: Map<string, EditTargetState>
  reservation?: { key: string; state: EditTargetState }
}

function limitBuilderEdits(ctx: Context): void {
  const byAgent = new WeakMap<object, Map<string, EditTargetState>>()
  const active = new WeakMap<object, EditAttempt>()

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'edit' || !exec.agent) return next()
    const targets = byAgent.get(exec.agent) ?? new Map<string, EditTargetState>()
    byAgent.set(exec.agent, targets)
    const attempt: EditAttempt = { targets }
    active.set(exec, attempt)
    try {
      return await next()
    } finally {
      active.delete(exec)
      const reservation = attempt.reservation
      if (reservation) {
        reservation.state.pending -= 1
        if (!reservation.state.committed && reservation.state.pending === 0) targets.delete(reservation.key)
      }
    }
  })
  // The filesystem tool supplies the resolved target that it will actually edit.
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const attempt = actor ? active.get(actor) : undefined
    if (!attempt) return next()
    const key = target.targetKey
    if (attempt.reservation) {
      if (attempt.reservation.key !== key) throw new Error('Cavecrew edit cannot change its resolved target.')
      return next()
    }
    let state = attempt.targets.get(key)
    if (!state) {
      if (attempt.targets.size >= 2) throw new Error('Cavecrew builder is limited to two file paths.')
      state = { pending: 0, committed: false }
      attempt.targets.set(key, state)
    }
    state.pending += 1
    attempt.reservation = { key, state }
    return next()
  }, { prepend: true })
  ctx.on('fs/observed', (target, observation, actor) => {
    const reservation = actor ? active.get(actor)?.reservation : undefined
    if (reservation?.key === target.targetKey && observation.kind === 'present') reservation.state.committed = true
  }, { prepend: true })
}

/** Install one original Cavecrew persona and keep its agent's tools bounded. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const original = await readFile(new URL(`../vendor/caveman/agents/cavecrew-${config.role}.md`, import.meta.url), 'utf8')
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(original)
  if (!frontmatter) throw new Error(`dsh-caveman: missing Cavecrew metadata for ${config.role}`)
  const body = original.slice(frontmatter[0].length).trim()
  ctx.systemPrompt.section({
    name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: body, interpolate: false,
  })
  ctx.systemPrompt.section({
    name: 'deployment:persona-suffix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: '', interpolate: false,
  })
  const allowed = config.role === 'builder' ? ['read', 'edit'] : ['read', 'glob', 'grep', 'cavecrew_git']
  if (config.role !== 'builder') {
    const role = config.role
    ctx.inject(['subprocess', 'workingDirectory'], scoped => registerCavecrewGit(scoped, role))
    ctx.systemPrompt.section({
      name: 'cavecrew:git', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: 'Use cavecrew_git for the permitted Git inspection operations. Use glob and grep for file searches; no shell is available.', interpolate: false,
    })
  }
  const permitted = new Set(allowed)
  ctx.tools.guard(exec => {
    if (!permitted.has(exec.name)) return `Cavecrew ${config.role} does not permit ${exec.name}.`
    if (config.role !== 'builder' || exec.name !== 'edit') return undefined
    if (!exec.agent || typeof exec.arguments !== 'object' || exec.arguments === null ||
      !('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string' || !exec.arguments.file_path.trim()) {
      return 'Cavecrew builder requires an existing file path.'
    }
    return undefined
  })
  if (config.role === 'builder') limitBuilderEdits(ctx)
  ctx.on('agent/created', async ({ agent }) => {
    const available = allowed.filter(tool => ctx.tools.get(tool, agent) !== undefined)
    agent.ctx.tools.restrict({ allow: available })
    const raw = process.env[`CAVECREW_${config.role.toUpperCase()}_MODEL`]
    const model = raw?.trim()
    if (model && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/u.test(model)) {
      const selected = agent.model.current()
      if (selected) {
        await ctx.llm.resolveModelInfo(selected.provider, model)
        agent.model.select({ provider: selected.provider, model })
      }
    }
    return undefined
  })
}
