import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import McpManager from '@deepseek-ai/dsh-mcp-manager'
import * as plugin from '../lib/index.js'

const binary = process.env.CAVEMAN_MCP_BINARY

test('Code-Mode is registered only for an explicit DSH gateway configuration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-codemode-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }))
  const path = join(directory, 'servers.json')
  await writeFile(path, '{"mcpServers":{}}')
  for (const codeMode of [undefined, { config: path, workspace: directory }]) {
    const servers = []
    const ctx = {
      effect() {},
      on() {},
      get() {},
      systemPrompt: { getSectionOrder: () => 0, section() {} },
      skills: { registerProvider() {} },
      inject(services, register) {
        if (!services.includes('mcpManager')) return
        register({ mcpManager: { list: () => [], register: (name, config) => servers.push({ name, ...config }) } })
      },
    }
    plugin.apply(ctx, { inputCompression: false, mcpBinary: process.execPath, codeMode })
    const gateway = servers.find(server => server.name === 'caveman_codemode')
    assert.deepEqual(gateway, codeMode && {
      name: 'caveman_codemode', transport: 'stdio', command: process.execPath,
      args: ['codemode', '--config', path, '--workspace', directory],
    })
  }
})

test('DSH exposes compression, recovery, statistics, and TOON tools through MCP', { skip: !binary, timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-mcp-'))
  const keys = ['CAVEMAN_HOME', 'CAVEMAN_MCP_BIN', 'CAVEMAN_MCP_EPHEMERAL', 'CAVEMAN_MCP', 'CAVEMAN_BROWSE_BIN']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.CAVEMAN_HOME = directory
  process.env.CAVEMAN_MCP_BIN = binary
  process.env.CAVEMAN_MCP_EPHEMERAL = '1'
  await writeFile(join(directory, 'cloud.json'), '{}')
  const codeModeConfig = join(directory, 'codemode.json')
  await writeFile(codeModeConfig, '{"mcpServers":{}}')
  const ctx = new Context()
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
    await ctx.plugin(McpManager, {})
    await ctx.plugin(plugin, {
      defaultMode: 'manual', inputCompression: false,
      codeMode: { config: codeModeConfig, workspace: directory },
    })
    for (let attempt = 0; attempt < 40 && !ctx.mcpManager.list().some(entry => entry.name === 'caveman'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ctx.mcpManager.list().some(entry => entry.name === 'caveman'), 'MCP server is registered automatically')
    for (let attempt = 0; attempt < 600; attempt++) {
      const status = ['caveman', 'caveman_codemode'].map(name => ctx.mcpManager.list().find(entry => entry.name === name)?.status)
      if (status.every(item => item?.state === 'connected')) break
      if (status.some(item => item?.state === 'failed') || attempt === 599) throw new Error(`Caveman MCP did not connect: ${JSON.stringify(status)}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const tools = ctx.tools.schemas().map(entry => entry.name)
    for (const name of ['caveman_compress', 'caveman_retrieve', 'caveman_stats', 'caveman_toon_encode', 'caveman_toon_decode']) {
      assert.ok(tools.includes(`mcp__caveman__${name}`), `${name} is available`)
    }
    for (const name of ['codemode_search_tools', 'codemode_execute', 'codemode_mutate', 'caveman_retrieve']) {
      assert.ok(tools.includes(`mcp__caveman_codemode__${name}`), `${name} is available`)
    }
    let callId = 0
    const call = async (name, args, server = 'caveman') => {
      const batch = await ctx.tools.execute({
        signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: `mcp-${++callId}`, name: `mcp__${server}__${name}`, arguments: JSON.stringify(args) }],
      })
      const result = batch.results[0].result
      assert.equal(result.isError, false, JSON.stringify(result))
      return result.content[0].text
    }
    await writeFile(join(directory, 'fixture.txt'), 'Caveman Code-Mode fixture')
    const codeModeResult = await call('codemode_execute', {
      code: 'return await mcp.repo.batch_read({paths: ["fixture.txt"]})',
    }, 'caveman_codemode')
    assert.match(codeModeResult, /Caveman Code-Mode fixture/)
    const json = JSON.stringify([{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }])
    const encoded = JSON.parse(await call('caveman_toon_encode', { input: json }))
    assert.equal(encoded.encoded, true)
    assert.deepEqual(JSON.parse(await call('caveman_toon_decode', { input: encoded.output })), JSON.parse(json))
    const original = Array.from({ length: 1200 }, (_, index) => `INFO request ${index} status=200 duration=12ms`).join('\n')
    const compressed = JSON.parse(await call('caveman_compress', { input: original }))
    assert.ok(compressed.recovery_handle)
    assert.equal(await call('caveman_retrieve', { recovery_handle: compressed.recovery_handle }), original)
    const stats = JSON.parse(await call('caveman_stats', {}))
    assert.ok(stats.requests >= 1)
    assert.equal(stats.basis, 'inferred')
  } finally {
    await ctx.fiber.dispose()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-mcp-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
