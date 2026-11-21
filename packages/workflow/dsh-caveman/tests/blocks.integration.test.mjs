import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as plugin from '../lib/index.js'

const blocksBinary = process.env.CAVEMAN_BLOCKS_BINARY

class LocalAdapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const args = JSON.stringify({ command: 'cat sample.json', description: 'Read a JSON file' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'shell-call', name: 'bash', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'shell-call', name: 'bash', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('the Blocks hook adds a hint without changing the shell command or result', { skip: !blocksBinary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-blocks-'))
  await mkdir(join(directory, '.blocks'))
  const previousState = process.env.XDG_STATE_HOME
  const previousTracking = process.env.DO_NOT_TRACK
  const previousHome = process.env.CAVEMAN_HOME
  const previousBinary = process.env.CAVEMAN_BLOCKS_BIN
  process.env.XDG_STATE_HOME = join(directory, 'state')
  process.env.DO_NOT_TRACK = '1'
  process.env.CAVEMAN_HOME = join(directory, 'home')
  process.env.CAVEMAN_BLOCKS_BIN = blocksBinary
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
    await ctx.plugin(plugin, { defaultMode: 'manual' })
    let received
    ctx.tools.register(defineTool({
      name: 'bash', description: 'Test shell.',
      parameters: { command: { type: 'string', required: true }, description: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) { received = args.command; return 'original tool output' },
    }))
    const adapter = new LocalAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create('blocks-session', { provider: 'mock', model: 'mock' }, { cwd: directory })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the file.' }] }))
    await agent.whenIdle()
    assert.equal(received, 'cat sample.json')
    assert.equal(adapter.requests[1].messages.find(message => message.role === 'tool').content[0].text, 'original tool output')
    const hint = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'dsh-caveman-blocks')
    assert.match(hint?.data.content[0].text ?? '', /json-peek/i)
  } finally {
    await ctx.fiber.dispose()
    if (previousState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousState
    if (previousTracking === undefined) delete process.env.DO_NOT_TRACK
    else process.env.DO_NOT_TRACK = previousTracking
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    if (previousBinary === undefined) delete process.env.CAVEMAN_BLOCKS_BIN
    else process.env.CAVEMAN_BLOCKS_BIN = previousBinary
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-blocks-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
