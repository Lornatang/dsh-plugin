import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const upstream = new URL('../vendor/superpowers/skills/', import.meta.url)
const names = [
  'brainstorming', 'diagnosing-superpowers', 'dispatching-parallel-agents',
  'executing-plans', 'finishing-a-development-branch', 'receiving-code-review',
  'requesting-code-review', 'subagent-driven-development', 'systematic-debugging',
  'test-driven-development', 'using-git-worktrees', 'using-superpowers',
  'verification-before-completion', 'writing-plans', 'writing-skills',
]

async function load(t) {
  const plugin = await import('../lib/index.js')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SystemPrompt)
  const fiber = ctx.plugin(plugin)
  await fiber
  return { ctx, fiber }
}

test('publishes the complete upstream skill catalog through the native DSH registry', async t => {
  const { ctx, fiber } = await load(t)
  const catalog = await ctx.skills.list()
  assert.deepEqual(catalog.map(skill => skill.name), names)
  for (const name of names) {
    const original = await readFile(new URL(`${name}/SKILL.md`, upstream), 'utf8')
    const skill = await ctx.skills.get(name)
    assert.equal(skill.content, original.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, ''))
    assert.equal(skill.provider, 'dsh-superpowers')
    assert.equal(skill.source, 'bundled')
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(skill.resourceBase.kind, 'directory')
    assert.equal(normalize(join(skill.resourceBase.path, 'SKILL.md')), normalize(skill.path))
  }
  const review = await ctx.skills.get('subagent-driven-development')
  assert.deepEqual(await readFile(join(review.resourceBase.path, 'references/preflight.md')),
    await readFile(new URL('subagent-driven-development/references/preflight.md', upstream)))
  await fiber.dispose()
  assert.deepEqual(await ctx.skills.list(), [])
})

test('assembles a single complete bootstrap on every controller prompt and skips delegated workers', async t => {
  const { ctx, fiber } = await load(t)
  const original = await readFile(new URL('using-superpowers/SKILL.md', upstream), 'utf8')
  const sections = async context => (await ctx.systemPrompt.assemble(context)).sections
    .filter(section => section.name === 'superpowers:bootstrap')
  const controller = { agent: { session: { header: {} } } }
  for (const context of [{}, controller, controller]) {
    const result = await sections(context)
    assert.equal(result.length, 1)
    assert.equal(result[0].interpolate, false)
    assert.ok(result[0].text.includes(original.trimEnd()))
    assert.match(result[0].text, /skill.*\{"name":"brainstorming"\}/u)
  }
  const delegated = { agent: { session: { header: { origin: 'subagent' } } } }
  assert.doesNotMatch(renderPrompt(await ctx.systemPrompt.assemble(delegated)), /You have superpowers/u)
  await fiber.dispose()
  assert.deepEqual(await sections(controller), [])
})
