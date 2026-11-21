import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

const root = fileURLToPath(new URL('../vendor/caveman/skills/', import.meta.url))

async function providerModule() {
  try { return await import('../lib/skills.js') } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/lib/skills.js')) return undefined
    throw error
  }
}

test('the DSH skill registry serves the voice and its resources', async () => {
  const module = await providerModule()
  assert.ok(module, 'skill provider is implemented')
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const dispose = ctx.skills.registerProvider(() => module.createSkillProvider(root))
  try {
    const catalog = await ctx.skills.list()
    for (const name of ['caveman', 'ultracave', 'megacave', 'caveman-help', 'caveman-commit', 'caveman-review', 'caveman-compress']) {
      assert.ok(catalog.some(candidate => candidate.name === name), `${name} is discoverable`)
    }
    const skill = await ctx.skills.get('caveman')
    const original = await readFile(new URL('../vendor/caveman/skills/caveman/SKILL.md', import.meta.url), 'utf8')
    const body = original.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim()
    assert.equal(skill.content, body)
    assert.equal(skill.resourceBase.kind, 'directory')
    assert.ok(skill.resourceBase.path.endsWith('/caveman'))
  } finally {
    dispose()
    assert.equal((await ctx.skills.list()).length, 0)
    await ctx.fiber.dispose()
  }
})

test('every skill is available to an explicit user invocation', async () => {
  const module = await providerModule()
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const dispose = ctx.skills.registerProvider(() => module.createSkillProvider(root))
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const catalog = await ctx.skills.list()
    let expected = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      let original
      try { original = await readFile(new URL(`../vendor/caveman/skills/${entry.name}/SKILL.md`, import.meta.url), 'utf8') } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      expected++
      const item = catalog.find(candidate => candidate.name === entry.name)
      assert.ok(item?.invocation.userInvocable, `${entry.name} accepts explicit invocation`)
      const skill = await ctx.skills.get(entry.name)
      assert.equal(skill.content, original.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim())
    }
    assert.equal(catalog.length, expected)
    assert.equal(catalog.find(item => item.name === 'cavecrew').invocation.modelInvocable, true)
    assert.equal(catalog.find(item => item.name === 'caveman-setup').invocation.modelInvocable, true)
    assert.equal(catalog.find(item => item.name === 'investigate-first').invocation.modelInvocable, true)
    assert.equal(catalog.find(item => item.name === 'ultracave').invocation.modelInvocable, false)
    assert.equal(catalog.find(item => item.name === 'megacave').invocation.modelInvocable, false)
  } finally {
    dispose()
    await ctx.fiber.dispose()
  }
})

test('partial skill discovery preserves order, cancellation, and invalidation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-skills-'))
  let invalidations = 0
  try {
    for (const name of ['caveman', 'ultracave']) {
      await mkdir(join(directory, name))
      const permission = name === 'caveman' ? 'disable-model-invocation: true' : 'user-invocable: false'
      await writeFile(join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n${permission}\n---\n${name} instructions\n`)
    }
    const { createSkillProvider } = await providerModule()
    const provider = createSkillProvider(directory, { invalidate() { invalidations++ } })
    const result = await provider.list({})
    assert.equal(result.complete, false)
    assert.deepEqual(result.candidates.map(candidate => candidate.name), ['caveman', 'ultracave'])
    assert.equal(result.candidates[0].invocation.modelInvocable, false)
    assert.equal(result.candidates[1].invocation.userInvocable, false)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(provider.list({ signal: controller.signal }))
    await rm(join(directory, 'caveman', 'SKILL.md'))
    assert.equal(await provider.get(result.candidates[0], {}), undefined)
    assert.equal(invalidations, 1)
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-skills-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
