import assert from 'node:assert/strict'
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

const plugin = await import('../lib/index.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/lib/index.js')) return undefined
  throw error
})

class LocalAdapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function send(agent, text) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
}

test('a real DSH agent receives mode rules and stop leaves another session untouched', async () => {
  assert.ok(plugin, 'DSH plugin entry is implemented')
  const ctx = new Context()
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
  const adapter = new LocalAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  try {
    const first = await ctx.agentLoop.create('first', { provider: 'mock', model: 'mock' })
    const second = await ctx.agentLoop.create('second', { provider: 'mock', model: 'mock' })
    await send(first, '/ultracave')
    await send(second, '/megacave')
    await send(first, 'stop caveman')
    await send(second, 'continue')
    const modeEvents = agent => agent.session.snapshotEvents()
      .filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-caveman-mode')
    assert.deepEqual(modeEvents(first).map(event => event.data.source.mode), ['ultracave', 'off'])
    assert.deepEqual(modeEvents(second).map(event => event.data.source.mode), ['megacave', 'megacave'])
    assert.match(modeEvents(first)[0].data.content[0].text, /ultracave/i)
    assert.match(modeEvents(first)[1].data.content[0].text, /off/i)
    assert.equal(adapter.requests.length, 4)
    assert.ok(first.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.data.content[0].text === '/ultracave'))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('disabling reinforcement keeps the initial and changed rules but omits later reminders', async (t) => {
  const previous = process.env.CAVEMAN_REINFORCE
  process.env.CAVEMAN_REINFORCE = '0'
  t.after(() => {
    if (previous === undefined) delete process.env.CAVEMAN_REINFORCE
    else process.env.CAVEMAN_REINFORCE = previous
  })
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, { defaultMode: 'caveman', inputCompression: false })
  ctx.llm.registerAdapter(['mock'], new LocalAdapter())
  const agent = await ctx.agentLoop.create('reinforcement', { provider: 'mock', model: 'mock' })
  await send(agent, 'first turn')
  await send(agent, 'second turn')
  await send(agent, '/ultracave')
  await send(agent, 'continue')
  const modes = agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-caveman-mode')
    .map(event => event.data.source.mode)
  assert.deepEqual(modes, ['caveman', 'ultracave'])
})

test('the stats command reports only recorded usage from its own DSH session', async () => {
  const ctx = new Context()
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
  class UsageAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new UsageAdapter())
  try {
    const first = await ctx.agentLoop.create('usage-first', { provider: 'mock', model: 'mock' })
    const other = await ctx.agentLoop.create('usage-other', { provider: 'mock', model: 'mock' })
    await send(first, 'one')
    await send(other, 'another session')
    await send(first, 'two')
    await send(first, '/caveman-stats')
    const event = first.session.snapshotEvents().find(item => item.type === 'user/message' && item.data.source.kind === 'dsh-caveman-stats')
    assert.ok(event, 'a report is supplied to the model')
    const text = event.data.content[0].text
    assert.match(text, /Recorded assistant messages: 2/)
    assert.match(text, /Output tokens: 14/)
    assert.match(text, /Cache-read tokens: 6/)
    assert.match(text, /Savings: unknown/)
    assert.equal(other.session.snapshotEvents().some(item => item.type === 'user/message' && item.data.source.kind === 'dsh-caveman-stats'), false)
    await send(other, '/caveman-stats --all')
    const otherReport = other.session.snapshotEvents().find(item => item.type === 'user/message' && item.data.source.kind === 'dsh-caveman-stats')
    assert.match(otherReport.data.content[0].text, /History unavailable; showing live sessions/)
    assert.match(otherReport.data.content[0].text, /Sessions counted: 2/)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('missing usage is reported as unavailable instead of zero', async () => {
  const { sessionStats } = await import('../lib/stats.js')
  const report = sessionStats([{ type: 'assistant/message', data: { message: {} } }], '')
  assert.match(report, /Messages with usage: 0 of 1/)
  assert.match(report, /Output tokens: unavailable/)
  assert.match(report, /Cache-read tokens: unavailable/)
})

test('session usage attributes recorded output to the active response mode', async () => {
  const { sessionStats } = await import('../lib/stats.js')
  const report = sessionStats([
    { type: 'assistant/message', data: { message: {}, usage: { outputTokens: 2 } } },
    { type: 'user/message', data: { source: { kind: 'dsh-caveman-mode', mode: 'ultracave' }, content: [] } },
    { type: 'assistant/message', data: { message: {}, usage: { outputTokens: 7 } } },
    { type: 'user/message', data: { source: { kind: 'dsh-caveman-mode', mode: 'off' }, content: [] } },
    { type: 'assistant/message', data: { message: {}, usage: { outputTokens: 3 } } },
  ], '')
  assert.match(report, /ultracave: 7/)
  assert.match(report, /off: 3/)
  assert.match(report, /unattributed: 2/)
})

test('partial usage and shareable summaries do not claim an unknown total', async () => {
  const { sessionStats } = await import('../lib/stats.js')
  const events = [
    { type: 'assistant/message', data: { message: {}, usage: { outputTokens: 7 } } },
    { type: 'assistant/message', data: { message: {} } },
  ]
  assert.match(sessionStats(events, ''), /Output tokens: 7 known \(partial; total unavailable\)/)
  assert.match(sessionStats(events, '--share'), /7 known \(partial; total unavailable\) output tokens; savings unknown/)
})
