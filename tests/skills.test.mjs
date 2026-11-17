import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

const skillDir = fileURLToPath(new URL('../upstream/skills/security-audit/', import.meta.url))

async function pluginModule() {
  try { return await import('../lib/index.js') } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/lib/index.js')) return undefined
    throw error
  }
}

test('the DSH registry loads the original skill, its resources and disposes it', async () => {
  const module = await pluginModule()
  assert.ok(module, 'DSH plugin has been built')
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(module.default)
    const summary = (await ctx.skills.list()).find(item => item.name === 'security-audit')
    assert.ok(summary, 'skill is discoverable')
    assert.equal(summary.invocation.modelInvocable, true)
    assert.equal(summary.invocation.userInvocable, true)
    const skill = await ctx.skills.get('security-audit')
    assert.ok(skill)
    const original = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    assert.equal(skill.content, original.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, ''))
    assert.equal(skill.resourceBase.kind, 'directory')
    assert.equal(resolve(skill.resourceBase.path), resolve(skillDir))
    for (const file of ['RECONNAISSANCE.md', 'HUNTING.md', 'VALIDATION-AND-REPORTING.md', 'report-schema.json', 'validate-findings.cjs', 'validate-coverage-ledger.cjs']) {
      assert.ok((await readFile(join(skill.resourceBase.path, file))).length > 0, file)
    }
    await fiber.dispose()
    assert.equal(await ctx.skills.get('security-audit'), undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a removed skill invalidates its provider rather than returning stale content', async () => {
  const module = await pluginModule()
  assert.ok(module, 'DSH plugin has been built')
  const temp = await mkdtemp(join(tmpdir(), 'dsh-security-audit-test-'))
  try {
    const dir = join(temp, 'security-audit')
    await mkdir(dir)
    await writeFile(join(dir, 'SKILL.md'), await readFile(join(skillDir, 'SKILL.md')))
    let invalidations = 0
    const provider = module.createSkillProvider(temp, { signal: new AbortController().signal, invalidate() { invalidations++ } })
    const observation = await provider.list({})
    assert.equal(observation.candidates.length, 1)
    await rm(join(dir, 'SKILL.md'))
    assert.equal(await provider.get(observation.candidates[0], {}), undefined)
    assert.equal(invalidations, 1)
  } finally {
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()), 'temporary directory stays under the system temp directory')
    await rm(temp, { recursive: true, force: true })
  }
})

test('provider discovery honors cancellation', async () => {
  const module = await pluginModule()
  assert.ok(module, 'DSH plugin has been built')
  const provider = module.createSkillProvider(dirname(skillDir))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider.list({ signal: controller.signal }), { name: 'AbortError' })
})
