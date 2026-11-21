import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as plugin from '../lib/index.js'

test('the native coding policy follows the output module and record mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-core-'))
  const keys = ['CAVEMAN_HOME', 'CAVEMAN_CORE', 'CAVEMAN_NATIVE_MODE', 'CAVEMAN_NATIVE_PROFILE', 'CAVEMAN_WRAP_MODE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.CAVEMAN_HOME = directory
  const expected = (await readFile(new URL('../vendor/caveman/skills/native/native-core.md', import.meta.url), 'utf8')).trim()
  async function assemble(config) {
    await writeFile(join(directory, 'cloud.json'), JSON.stringify(config))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: false })
      return (await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'caveman:core')?.text
    } finally { await ctx.fiber.dispose() }
  }
  try {
    assert.equal(await assemble({}), expected)
    assert.equal(await assemble({ modules: { output: false } }), undefined)
    process.env.CAVEMAN_NATIVE_PROFILE = 'core-lean-build'
    const lean = (await readFile(new URL('../vendor/caveman/skills/lean-build/SKILL.md', import.meta.url), 'utf8'))
      .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim()
    assert.equal(await assemble({}), `${expected} ${lean}`)
    delete process.env.CAVEMAN_NATIVE_PROFILE
    process.env.CAVEMAN_NATIVE_MODE = 'record'
    assert.equal(await assemble({ modules: { output: true } }), undefined)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-core-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('the native coding policy reaches a real DSH model request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-core-'))
  const keys = ['CAVEMAN_HOME', 'CAVEMAN_CORE', 'CAVEMAN_NATIVE_MODE', 'CAVEMAN_NATIVE_PROFILE', 'CAVEMAN_WRAP_MODE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.CAVEMAN_HOME = directory
  await writeFile(join(directory, 'cloud.json'), '{}')
  const ctx = new Context()
  class Adapter extends LlmAdapter {
    requests = []
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) { this.requests.push(options); yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: false })
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create('native-policy-session', { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the task.' }] }))
    await agent.whenIdle()
    assert.equal(adapter.requests.length, 1)
    assert.match(JSON.stringify(adapter.requests[0]), /Build simplest complete system/)
  } finally {
    await ctx.fiber.dispose()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-core-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
