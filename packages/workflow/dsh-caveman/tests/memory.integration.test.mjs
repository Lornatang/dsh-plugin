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
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as plugin from '../lib/index.js'

const binary = process.env.CAVEMEM_BINARY

test('the memory MCP stores, recalls, revises, and forgets local facts', { skip: !binary, timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-memory-'))
  const keys = ['CAVEMAN_HOME', 'CAVEMAN_MCP', 'CAVEMAN_MCP_BIN', 'CAVEMAN_BROWSE_BIN', 'CAVEMEM_BIN']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.CAVEMAN_HOME = directory
  process.env.CAVEMEM_BIN = binary
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
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: directory })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: directory })
    await ctx.plugin(McpManager, {})
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: false })
    for (let attempt = 0; attempt < 40 && !ctx.mcpManager.list().some(entry => entry.name === 'cavemem'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ctx.mcpManager.list().some(entry => entry.name === 'cavemem'), 'installed memory server is discovered and registered')
    const waitConnected = async () => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const status = ctx.mcpManager.list().find(entry => entry.name === 'cavemem')?.status
        if (status?.state === 'connected') return
        if (status?.state === 'failed') throw new Error(`Memory MCP failed: ${JSON.stringify(status)}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Memory MCP did not connect')
    }
    await waitConnected()
    let callId = 0
    const call = async (name, args) => {
      const batch = await ctx.tools.execute({ signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: `memory-${++callId}`, name: `mcp__cavemem__cavemem_${name}`, arguments: JSON.stringify(args) }],
      })
      const result = batch.results[0].result
      assert.equal(result.isError, false, JSON.stringify(result))
      return JSON.parse(result.content[0].text)
    }
    const remembered = await call('remember', { text: 'The staging cluster runs in eu-west-1.' })
    assert.ok(remembered.id)
    await ctx.mcpManager.restart('cavemem')
    await waitConnected()
    const recalled = await call('recall', { query: 'which region does the staging cluster run in' })
    assert.equal(recalled.hits[0].id, remembered.id)
    const updated = await call('supersede', { id: remembered.id, text: 'The staging cluster runs in eu-central-1.' })
    assert.ok(updated.id)
    const history = await call('history', { id: updated.id })
    assert.equal(history.history.length, 2)
    assert.equal((await call('forget', { id: updated.id })).forgotten, true)
    const longMemory = Array.from({ length: 900 }, (_, index) => `Project sequoia record ${index}: service check passed in the west region.`).join('\n')
    await call('remember', { text: longMemory })
    const large = await call('recall', { query: 'project sequoia record', token_budget: 20 })
    assert.ok(large.hits[0].recovery_handle)
    const recovered = await ctx.tools.execute({ signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'memory-recovery', name: 'cavemem_recover', arguments: JSON.stringify({ handle: large.hits[0].recovery_handle }) }],
    })
    assert.equal(recovered.results[0].result.isError, false, JSON.stringify(recovered.results[0].result))
    assert.equal(recovered.results[0].result.content[0].text, longMemory)
  } finally {
    await ctx.fiber.dispose()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-memory-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
