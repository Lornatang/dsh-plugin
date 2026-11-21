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

test('DSH exposes compression, recovery, statistics, and TOON tools through MCP', { skip: !binary, timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-mcp-'))
  const keys = ['CAVEMAN_HOME', 'CAVEMAN_MCP_BIN', 'CAVEMAN_MCP_EPHEMERAL', 'CAVEMAN_MCP', 'CAVEMAN_BROWSE_BIN']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.CAVEMAN_HOME = directory
  process.env.CAVEMAN_MCP_BIN = binary
  process.env.CAVEMAN_MCP_EPHEMERAL = '1'
  await writeFile(join(directory, 'cloud.json'), '{}')
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
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: false })
    for (let attempt = 0; attempt < 40 && !ctx.mcpManager.list().some(entry => entry.name === 'caveman'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ctx.mcpManager.list().some(entry => entry.name === 'caveman'), 'MCP server is registered automatically')
    for (let attempt = 0; attempt < 600; attempt++) {
      const status = ctx.mcpManager.list().find(entry => entry.name === 'caveman')?.status
      if (status?.state === 'connected') break
      if (status?.state === 'failed' || attempt === 599) throw new Error(`Caveman MCP did not connect: ${JSON.stringify(status)}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const tools = ctx.tools.schemas().map(entry => entry.name)
    for (const name of ['caveman_compress', 'caveman_retrieve', 'caveman_stats', 'caveman_toon_encode', 'caveman_toon_decode']) {
      assert.ok(tools.includes(`mcp__caveman__${name}`), `${name} is available`)
    }
    let callId = 0
    const call = async (name, args) => {
      const batch = await ctx.tools.execute({
        signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: `mcp-${++callId}`, name: `mcp__caveman__${name}`, arguments: JSON.stringify(args) }],
      })
      const result = batch.results[0].result
      assert.equal(result.isError, false, JSON.stringify(result))
      return result.content[0].text
    }
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
