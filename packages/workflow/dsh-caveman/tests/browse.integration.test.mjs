import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import McpManager from '@deepseek-ai/dsh-mcp-manager'
import * as plugin from '../lib/index.js'

const browseBinary = process.env.CAVEMAN_BROWSE_BINARY
const chrome = process.env.CAVEMAN_BROWSE_CHROME

function call(id, name, args) {
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class LocalAdapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    let chunks
    if (this.requests.length === 1) {
      const rows = Array.from({ length: 80 }, (_, index) => `<li>Fixture item ${index}</li>`).join('')
      const url = `data:text/html,${encodeURIComponent(`<html><body><h1>Browse fixture</h1><ul>${rows}</ul></body></html>`)}`
      chunks = call('snapshot', 'mcp__caveman_browse__browser_snapshot', { url })
    } else if (this.requests.length === 2) {
      const text = options.messages.filter(message => message.role === 'tool').at(-1)?.content?.[0]?.text ?? ''
      let handle
      try { handle = JSON.parse(text).recovery_handle } catch {}
      chunks = handle
        ? call('recover', 'mcp__caveman_browse__browser_recover', { recovery_handle: handle })
        : [{ type: 'finish', reason: { kind: 'stop' } }]
    } else chunks = [{ type: 'finish', reason: { kind: 'stop' } }]
    for (const chunk of chunks) yield chunk
  }
}

test('DSH connects the Browse MCP server, snapshots a page, and recovers its original tree', {
  skip: !browseBinary || !chrome, timeout: 120_000,
}, async () => {
  const ctx = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-browse-'))
  const previousEphemeral = process.env.CAVEMAN_BROWSE_EPHEMERAL
  const previousHome = process.env.CAVEMAN_HOME
  const previousBinary = process.env.CAVEMAN_BROWSE_BIN
  process.env.CAVEMAN_BROWSE_EPHEMERAL = '1'
  process.env.CAVEMAN_HOME = directory
  process.env.CAVEMAN_BROWSE_BIN = browseBinary
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
    await ctx.plugin(plugin, { defaultMode: 'manual' })
    for (let attempt = 0; attempt < 600; attempt++) {
      const status = ctx.mcpManager.list().find(entry => entry.name === 'caveman_browse')?.status
      if (status?.state === 'connected') break
      if (status?.state === 'failed' || attempt === 599) throw new Error(`Browse MCP server did not connect: ${JSON.stringify(status)}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const adapter = new LocalAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create('browse-session', { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the fixture.' }] }))
    await agent.whenIdle()
    assert.equal(adapter.requests.length, 3, 'the model can snapshot and recover the original')
    const snapshot = adapter.requests[1].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    const payload = JSON.parse(snapshot)
    assert.match(payload.uids, /Browse fixture/)
    assert.ok(payload.recovery_handle)
    const recovered = adapter.requests[2].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    assert.match(recovered, /Browse fixture/)
    assert.match(recovered, /Fixture item 79/)
  } finally {
    await ctx.fiber.dispose()
    if (previousEphemeral === undefined) delete process.env.CAVEMAN_BROWSE_EPHEMERAL
    else process.env.CAVEMAN_BROWSE_EPHEMERAL = previousEphemeral
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    if (previousBinary === undefined) delete process.env.CAVEMAN_BROWSE_BIN
    else process.env.CAVEMAN_BROWSE_BIN = previousBinary
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-browse-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('an existing Browse server is kept when the plugin is installed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-browse-'))
  const previousHome = process.env.CAVEMAN_HOME
  process.env.CAVEMAN_HOME = directory
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
    await ctx.plugin(McpManager, { servers: { caveman_browse: { transport: 'stdio', command: process.execPath, enabled: false } } })
    const register = ctx.mcpManager.register.bind(ctx.mcpManager)
    let attempts = 0
    ctx.mcpManager.register = (...args) => { attempts++; return register(...args) }
    const handle = await ctx.plugin(plugin, { defaultMode: 'manual', browseBinary: process.execPath })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(handle, 'plugin starts alongside the existing server')
    assert.equal(attempts, 0, 'the existing configuration is not replaced')
    const servers = ctx.mcpManager.list().filter(entry => entry.name === 'caveman_browse')
    assert.equal(servers.length, 1)
    assert.equal(servers[0].status.state, 'disabled')
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-browse-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('the Browse module switch prevents automatic server registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-browse-'))
  const previousHome = process.env.CAVEMAN_HOME
  process.env.CAVEMAN_HOME = directory
  await writeFile(join(directory, 'cloud.json'), JSON.stringify({ modules: { browse: false } }))
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
    await ctx.plugin(plugin, { defaultMode: 'manual', browseBinary: process.execPath })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(ctx.mcpManager.list().some(entry => entry.name === 'caveman_browse'), false)
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-browse-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
