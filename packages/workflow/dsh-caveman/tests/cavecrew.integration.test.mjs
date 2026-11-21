import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as plugin from '../lib/index.js'
import { parse as parseYaml } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))

test('Cavecrew presets load original personas and restrict each real DSH agent', async () => {
  const patch = parseYaml(await readFile(new URL('../presets/cavecrew.patch.yml', import.meta.url), 'utf8'))
  const entries = patch.flatMap(item => item.insert ?? [])
  const roles = ['investigator', 'builder', 'reviewer']
  const modelEnvironment = Object.fromEntries(roles.map(role => {
    const key = `CAVECREW_${role.toUpperCase()}_MODEL`
    const previous = process.env[key]
    process.env[key] = `fixture-${role}`
    return [key, previous]
  }))
  assert.deepEqual(entries.filter(item => item.name === '@deepseek-ai/dsh-agent-preset').map(item => item.config.id).sort(),
    roles.map(role => `cavecrew-${role}`).sort())
  assert.deepEqual(entries.filter(item => item.name === '@deepseek-ai/dsh-tool-subagent').map(item => item.config.agentPreset).sort(),
    roles.map(role => `cavecrew-${role}`).sort())
  const ctx = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cavecrew-test-'))
  execFileSync('git', ['init', '-q'], { cwd: directory })
  await writeFile(join(directory, 'fixture.txt'), 'needle original\n')
  execFileSync('git', ['add', 'fixture.txt'], { cwd: directory })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: directory })
  execFileSync('git', ['config', 'diff.external', 'nonexistent-external-diff'], { cwd: directory })
  execFileSync('git', ['config', 'core.fsmonitor', 'nonexistent-fsmonitor'], { cwd: directory })
  await writeFile(join(directory, 'fixture.txt'), 'needle updated\n')
  ctx.baseUrl = pathToFileURL(join(root, 'package.json')).href
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalFileSystem, { cwd: directory })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(WorkingDirectory, { defaultDirectory: directory })
    await ctx.plugin(JsonlSessionPersistence, { root: directory })
    await ctx.plugin(AgentPresets, { default: 'cavecrew-investigator' })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(plugin, { defaultMode: 'caveman' })
    class LocalAdapter extends LlmAdapter {
      requests = []
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream(options) { this.requests.push(options); yield { type: 'finish', reason: { kind: 'stop' } } }
    }
    const adapter = new LocalAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    for (const name of ['bash', 'write']) ctx.tools.register(defineTool({
      name, description: `Fixture ${name}`, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'ran' },
    }))
    for (const row of entries.filter(item => item.name === '@deepseek-ai/dsh-agent-preset')) {
      await ctx.plugin(AgentPreset, row.config)
    }
    for (const role of roles) {
      const preset = await ctx.agentPresets.resolve(`cavecrew-${role}`)
      assert.equal(preset.broken, undefined, `${role} preset mounts successfully`)
      const handle = await ctx.agents.create({
        sessionId: `cavecrew-${role}-test`, agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, `cavecrew-${role}`) },
      })
      const agent = handle.agent
      assert.equal(agent.model.current().model, `fixture-${role}`, `${role} honors its model override`)
      const visible = ctx.tools.schemas(agent).map(tool => tool.name).sort()
      const expected = role === 'builder' ? ['edit', 'read'] : ['cavecrew_git', 'glob', 'grep', 'read']
      assert.deepEqual(visible, expected, `${role} exposes only its allowed tools`)
      assert.ok(ctx.tools.checkGuards({ name: 'bash', agent, arguments: {} }), `${role} denies shell execution`)
      assert.ok(ctx.tools.checkGuards({ name: 'write', agent, arguments: {} }), `${role} denies file creation`)
      if (role !== 'builder') assert.ok(ctx.tools.checkGuards({ name: 'edit', agent, arguments: {} }), `${role} denies editing`)
      if (role === 'builder') {
        const edit = file_path => ctx.tools.checkGuards({ name: 'edit', agent, arguments: { file_path } })
        assert.equal(edit('one.txt'), undefined)
        assert.equal(edit('two.txt'), undefined)
        assert.match(edit('three.txt').reason, /two file paths/)
      }
      const denied = await ctx.tools.execute({
        agent, signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: 'blocked-shell', name: 'bash', arguments: '{}' }],
      })
      assert.equal(denied.results[0].result.isError, true, 'the executor refuses hidden shell calls')
      const runGit = async args => {
        const execution = await ctx.tools.execute({
          agent, signal: new AbortController().signal,
          calls: [{ type: 'tool-call', id: `git-${role}`, name: 'cavecrew_git', arguments: JSON.stringify(args) }],
        })
        return execution.results[0].result
      }
      if (role === 'investigator') {
        const found = await runGit({ operation: 'grep', query: 'needle', path: 'fixture.txt' })
        assert.equal(found.isError, false)
        assert.match(found.content[0].text, /fixture\.txt:1:needle updated/)
        const log = await runGit({ operation: 'log', query: 'needle' })
        assert.equal(log.isError, false)
        assert.match(log.content[0].text, /fixture/)
        assert.equal((await runGit({ operation: 'show', revision: 'HEAD' })).isError, true)
      }
      if (role === 'reviewer') {
        const diff = await runGit({ operation: 'diff', path: 'fixture.txt' })
        assert.equal(diff.isError, false)
        assert.match(diff.content[0].text, /\+needle updated/)
        const show = await runGit({ operation: 'show', revision: 'HEAD', path: 'fixture.txt' })
        assert.equal(show.isError, false)
        assert.match(show.content[0].text, /needle original/)
        const log = await runGit({ operation: 'log', path: 'fixture.txt' })
        assert.equal(log.isError, false)
        assert.match(log.content[0].text, /fixture/)
        assert.equal((await runGit({ operation: 'show', revision: '--output=escaped.txt' })).isError, true)
        assert.equal((await runGit({ operation: 'grep', query: 'needle' })).isError, true)
      }
      if (role === 'builder') assert.equal((await runGit({ operation: 'diff' })).isError, true)
      const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent))
      assert.ok(!prompt.sections.find(section => section.name === 'caveman:core')?.text, 'Cavecrew keeps its specialized policy')
      const persona = prompt.sections.find(section => section.name === 'deployment:persona-prefix')
      const original = await readFile(new URL(`../vendor/caveman/agents/cavecrew-${role}.md`, import.meta.url), 'utf8')
      const body = original.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim()
      assert.equal(persona.text, body)
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect this task.' }] }))
      await agent.whenIdle()
      assert.ok(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'user'), 'the agent processed the input')
      assert.equal(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-caveman-mode'), false,
        'Cavecrew keeps its own voice rather than inheriting the main session reminder')
    }
    assert.ok(ctx.tools.get('bash'), 'the parent tool scope remains unchanged')
    assert.equal(adapter.requests.length, roles.length)
    for (const [label, value] of [['blank', '   '], ['control', 'fixture\ninjected']]) {
      process.env.CAVECREW_REVIEWER_MODEL = value
      const handle = await ctx.agents.create({
        sessionId: `cavecrew-reviewer-${label}`, agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'cavecrew-reviewer') },
      })
      assert.equal(handle.agent.model.current().model, 'mock', `${label} override keeps the inherited model`)
    }
    await ctx.plugin(SubagentRuntime, {})
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    const investigatorTool = entries.find(item => item.id === 'tool-cavecrew-investigator')
    await ctx.plugin(ToolSubagent, investigatorTool.config)
    const parent = await ctx.agentLoop.create('cavecrew-parent-test', { provider: 'mock', model: 'mock' }, { cwd: root })
    const activation = await ctx.tools.execute({
      agent: parent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'delegate', name: 'cavecrew-investigator',
        arguments: JSON.stringify({ description: 'Locate code', prompt: 'Locate the fixture.' }) }],
    })
    assert.equal(activation.results[0].result.isError, false, JSON.stringify(activation.results[0].result))
    assert.equal(await ctx.subagents.waitForTreeWork(parent), true)
    assert.equal(adapter.requests.length, roles.length + 1)
    const request = adapter.requests.at(-1)
    assert.match(JSON.stringify(request), /Locate\. Report\. Stop\./)
    assert.deepEqual(request.tools.map(tool => tool.name).sort(), ['cavecrew_git', 'glob', 'grep', 'read'])
  } finally {
    await ctx.fiber.dispose()
    for (const [key, previous] of Object.entries(modelEnvironment)) {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-cavecrew-test-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
