import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as plugin from '../lib/index.js'

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
async function send(agent, text) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
}

test('historical usage combines stored and live sessions without counting fork history twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-stats-'))
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: directory })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: false })
    ctx.llm.registerAdapter(['mock'], new UsageAdapter())
    const old = await ctx.agents.create({ sessionId: 'stats-stored', agentOptions: { provider: 'mock', model: 'mock' } })
    await send(old.agent, 'Stored session.')
    await old.dispose()
    const active = await ctx.agents.create({ sessionId: 'stats-active', agentOptions: { provider: 'mock', model: 'mock' } })
    await send(active.agent, 'Live session.')
    ctx.sessions.fork(active.agent.session, undefined, 'stats-fork')
    await send(active.agent, '/caveman-stats --all')
    let report = active.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-caveman-stats').at(-1).data.content[0].text
    assert.match(report, /Sessions counted: 3/)
    assert.match(report, /Output tokens: 14/)
    assert.match(report, /Savings: unknown/)
    await send(active.agent, '/caveman-stats --since 1h')
    report = active.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-caveman-stats').at(-1).data.content[0].text
    assert.match(report, /Output tokens: 21/)
    assert.match(report, /last 1h/)
    await send(active.agent, '/caveman-stats --since invalid')
    report = active.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-caveman-stats').at(-1).data.content[0].text
    assert.match(report, /--since.*Nh or Nd/)
  } finally {
    await ctx.fiber.dispose()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-stats-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('stored-session errors remain visible without losing other session totals', async () => {
  const { statsReport } = await import('../lib/stats.js')
  const now = Date.now()
  const event = { type: 'assistant/message', time: now, data: { message: {}, usage: { outputTokens: 7 } } }
  const live = { id: 'live', header: { createdAt: now }, inheritedEventCount: 0, snapshotEvents: () => [event] }
  const persistence = {
    async list() { return [{ header: { id: 'good', createdAt: now } }, { header: { id: 'bad', createdAt: now } }] },
    async open(id) {
      if (id === 'bad') throw new Error('unreadable')
      return { inheritedEventCount: 0, async read() { return { events: [event] } }, async close() { throw new Error('close failed') } }
    },
  }
  const ctx = { get(name) { return name === 'sessions' ? { list: () => [live] } : name === 'sessionPersistence' ? persistence : undefined } }
  const report = await statsReport(ctx, live, '--all', new AbortController().signal)
  assert.match(report, /Sessions counted: 2/)
  assert.match(report, /Output tokens: 14/)
  assert.match(report, /Stored session read or close errors: 2/)
  assert.doesNotMatch(report, /History unavailable; showing live sessions only/)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(statsReport({ get: () => undefined }, live, '--all', cancelled.signal))
})

test('a time-window report excludes older usage while retaining its response-mode context', async () => {
  const { statsReport } = await import('../lib/stats.js')
  const now = Date.now()
  const events = [
    { type: 'user/message', time: now - 7_200_000, data: { source: { kind: 'dsh-caveman-mode', mode: 'ultracave' }, content: [] } },
    { type: 'assistant/message', time: now - 7_100_000, data: { message: {}, usage: { outputTokens: 100 } } },
    { type: 'assistant/message', time: now - 1_000, data: { message: {}, usage: { outputTokens: 7 } } },
  ]
  const session = { id: 'mixed-window', header: { createdAt: now - 7_200_000 }, inheritedEventCount: 0, snapshotEvents: () => events }
  const ctx = { get(name) { return name === 'sessions' ? { list: () => [session] } : undefined } }
  const report = await statsReport(ctx, session, '--since 1h', new AbortController().signal)
  assert.match(report, /Sessions counted: 1/)
  assert.match(report, /Recorded assistant messages: 1/)
  assert.match(report, /Output tokens: 7(?:\n|$)/)
  assert.match(report, /ultracave: 7/)
  assert.doesNotMatch(report, /107/)
  const shared = await statsReport(ctx, session, '--since 1h --share', new AbortController().signal)
  assert.match(shared, /^Caveman: 1 recorded assistant messages, 7 output tokens; savings unknown\./u)
  assert.match(shared, /History incomplete/u)
  assert.doesNotMatch(shared, /107/u)
})
