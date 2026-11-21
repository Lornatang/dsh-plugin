import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
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
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as plugin from '../lib/index.js'

const proxyBinary = process.env.CAVEMAN_PROXY_BINARY
const original = Array.from({ length: 1200 }, (_, i) => `INFO request ${i} GET /api/test status=200 duration=12ms`).join('\n')

async function startProxy() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-test-'))
  await writeFile(join(directory, 'cloud.json'), JSON.stringify({ modules: { input: true } }))
  const probe = createServer()
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).on('error', reject))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const child = spawn(proxyBinary, ['serve'], {
    windowsHide: true,
    env: { ...process.env, CAVEMAN_HOME: directory, CAVEMAN_CONFIG: join(directory, 'missing.yaml'), CAVEMAN_LISTEN: `127.0.0.1:${port}`, CAVEMAN_MODE: 'compress', CAVEMAN_MIDDLEWARE_MODE: 'compress' },
    stdio: 'ignore',
  })
  const endpoint = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${endpoint}/caveman/v1/middleware/capabilities`)).ok) break } catch {}
    if (child.exitCode !== null) throw new Error(`proxy exited: ${child.exitCode}`)
    if (attempt === 99) throw new Error('proxy did not start')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return {
    endpoint, home: directory,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill()
        await exited
      }
    },
    async close() {
      await this.stop()
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-test-')) throw new Error('unexpected test directory')
      await rm(directory, { recursive: true, force: true })
    },
  }
}

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
  onCompressed
  constructor(onCompressed) { super(); this.onCompressed = onCompressed }
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    let chunks
    if (this.requests.length === 1) chunks = call('output-call', 'large_fixture', {})
    else if (this.requests.length === 2) {
      const text = options.messages.filter(message => message.role === 'tool').at(-1)?.content?.[0]?.text ?? ''
      const handle = /handle=(cmw_[a-f0-9]{48})/.exec(text)?.[1]
      if (handle) await this.onCompressed?.()
      chunks = handle ? call('retrieve-call', 'caveman_retrieve', { handle }) : [{ type: 'finish', reason: { kind: 'stop' } }]
    } else chunks = [{ type: 'finish', reason: { kind: 'stop' } }]
    for (const chunk of chunks) yield chunk
  }
}

async function exerciseRecovery(stopBeforeRecovery, denyRecovery = false, failRestoreOnce = false, automatic = false, disabled = false) {
  const service = await startProxy()
  const ctx = new Context()
  const previousHome = process.env.CAVEMAN_HOME
  process.env.CAVEMAN_HOME = service.home
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
    await ctx.plugin(plugin, { defaultMode: 'manual', ...(disabled ? { inputCompression: false } : automatic ? {} : { inputCompression: true }), middlewareEndpoint: service.endpoint })
    ctx.tools.register(defineTool({
      name: 'large_fixture', description: 'Return a large sample.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return original },
    }))
    const adapter = new LocalAdapter(stopBeforeRecovery ? () => service.stop() : undefined)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create('compression-session', { provider: 'mock', model: 'mock' })
    if (denyRecovery) agent.ctx.get('tools').restrict({ deny: ['caveman_retrieve'] })
    let restoreFailed = false
    if (failRestoreOnce) {
      const append = agent.session.append.bind(agent.session)
      agent.session.append = (type, data, options) => {
        if (!restoreFailed && type === 'tool/result' && options?.sourceEventSeqs?.length === 2) {
          restoreFailed = true
          throw new Error('injected transient restore failure')
        }
        return append(type, data, options)
      }
    }
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the sample.' }] }))
    await agent.whenIdle()
    if (failRestoreOnce) {
      assert.ok(restoreFailed, 'the test exercised a failed restoration')
      const visible = agent.session.surface.nodes.map(seq => agent.session.eventAt(seq))
      assert.ok(visible.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'output-call' && event.data.message.content[0]?.text === original), 'idle cleanup retries restoration after a transient failure')
      return
    }
    if (denyRecovery || disabled) {
      assert.equal(adapter.requests.length, 2)
      const visible = adapter.requests[1].messages.filter(message => message.role === 'tool').at(-1).content[0].text
      assert.equal(visible, original, 'without a callable recovery tool the original passes through')
      return
    }
    assert.equal(adapter.requests.length, 3, 'model can invoke recovery after seeing compressed output')
    const compressed = adapter.requests[1].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    assert.ok(compressed.length < original.length / 4)
    const recovered = adapter.requests[2].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    assert.equal(JSON.parse(recovered).text, original)
    assert.ok(agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.content[0]?.text === original), 'the original event remains in the session log')
    const visible = agent.session.surface.nodes.map(seq => agent.session.eventAt(seq))
    assert.ok(visible.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'output-call' && event.data.message.content[0]?.text === original), 'the visible session is restored after dispatch')
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    await service.close()
  }
}

test('DSH compresses recoverably while preserving the original session event', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(false)
})

async function exercisePtcRecovery({ stopBeforeRecovery = false, denyRecovery = false, omitSdk = false } = {}) {
  const service = await startProxy()
  const optimizePayloads = []
  const destination = new URL(service.endpoint)
  const relay = createHttpServer((incoming, outgoing) => {
    if (incoming.url?.endsWith('/optimize')) {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('end', () => optimizePayloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    }
    const request = httpRequest({ hostname: destination.hostname, port: destination.port, path: incoming.url, method: incoming.method, headers: incoming.headers, agent: false }, response => {
      outgoing.writeHead(response.statusCode ?? 500, response.headers)
      response.pipe(outgoing)
    })
    request.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
    incoming.pipe(request)
  })
  await new Promise((resolve, reject) => relay.listen(0, '127.0.0.1', resolve).on('error', reject))
  const endpoint = `http://127.0.0.1:${relay.address().port}`
  const previousHome = process.env.CAVEMAN_HOME
  process.env.CAVEMAN_HOME = service.home
  const ctx = new Context()
  class TestRuntime extends PtcRuntime {
    language = 'typescript'
    isolation = 'test'
    resolve(request) { return { ...request, cwd: request.cwd ?? service.home, timeoutMs: request.timeoutMs ?? 120_000 } }
    async run(request) {
      if (request.program.startsWith('recover:')) {
        const tools = request.bindings.find(binding => binding.global === 'tools').functions
        return { logs: [await tools.caveman_retrieve({ handle: request.program.slice('recover:'.length) })] }
      }
      return { logs: [original] }
    }
  }
  class PtcAdapter extends LlmAdapter {
    requests = []
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      this.requests.push(options)
      let chunks
      if (this.requests.length === 1) chunks = call('program-output', 'run_code', { code: 'output', description: 'Read the sample' })
      else if (this.requests.length === 2) {
        const text = options.messages.filter(message => message.role === 'tool').at(-1)?.content?.[0]?.text ?? ''
        const handle = /handle=(cmw_[a-f0-9]{48})/.exec(text)?.[1]
        if (handle && stopBeforeRecovery) await service.stop()
        chunks = handle ? call('program-recover', 'run_code', { code: `recover:${handle}`, description: 'Recover original' }) : [{ type: 'finish', reason: { kind: 'stop' } }]
      } else chunks = [{ type: 'finish', reason: { kind: 'stop' } }]
      yield* chunks
    }
  }
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: service.home })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: service.home })
    await ctx.plugin(TestRuntime)
    await ctx.plugin(PtcToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: true, middlewareEndpoint: endpoint })
    if (omitSdk) ctx.on('system-prompt/assemble', async (presentation, context, next) => {
      const result = await next()
      return { ...result, sections: result.sections.filter(section => section.name !== 'tools:sdk') }
    })
    const adapter = new PtcAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create('ptc-compression-session', { provider: 'mock', model: 'mock' })
    if (denyRecovery) agent.ctx.get('tools').restrict({ deny: ['caveman_retrieve'] })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the sample.' }] }))
    await agent.whenIdle()
    if (denyRecovery || omitSdk) {
      assert.equal(adapter.requests.length, 2)
      assert.equal(adapter.requests[1].messages.filter(message => message.role === 'tool').at(-1).content[0].text, original)
      return
    }
    assert.equal(adapter.requests.length, 3, 'model can recover the compressed result through run_code')
    const system = adapter.requests[1].messages.filter(message => message.role === 'system').flatMap(message => message.content).map(block => block.text ?? '').join('\n')
    assert.match(system, /caveman_retrieve: \{[\s\S]*?handle: string/u, 'SDK describes recovery arguments')
    const compressed = adapter.requests[1].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    assert.ok(compressed.length < original.length / 4)
    const recovered = adapter.requests[2].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    assert.equal(JSON.parse(recovered).text, original)
    if (!stopBeforeRecovery) {
      const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'program-recover')
      assert.ok(result)
      const ids = optimizePayloads.flatMap(payload => (payload.segments ?? payload.candidates ?? []).map(segment => segment.source_id ?? segment.sourceId))
      assert.ok(ids.length, JSON.stringify(optimizePayloads.map(payload => Object.keys(payload))))
      assert.ok(!ids.includes(`seq-${result.seq}`), 'a recovery result is not sent back for compression')
    }
  } finally {
    await ctx.fiber.dispose()
    await new Promise(resolve => relay.close(resolve))
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    await service.close()
  }
}

test('programmatic tool execution recovers a compressed run_code result', { skip: !proxyBinary }, async () => {
  await exercisePtcRecovery()
  await exercisePtcRecovery({ stopBeforeRecovery: true })
})

test('programmatic compression requires an allowed, visible recovery binding', { skip: !proxyBinary }, async () => {
  await exercisePtcRecovery({ denyRecovery: true })
  await exercisePtcRecovery({ omitSdk: true })
})

test('a verified local runtime enables compression and offline recovery automatically', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(true, false, false, true)
})

test('disabling input compression keeps the original tool output', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(false, false, false, true, true)
})

test('multiple tool-result text blocks remain separate and recoverable', { skip: !proxyBinary }, async () => {
  const service = await startProxy()
  const previousHome = process.env.CAVEMAN_HOME
  process.env.CAVEMAN_HOME = service.home
  const ctx = new Context()
  const second = original.replaceAll('GET /api/test', 'POST /api/check')
  class MultiAdapter extends LlmAdapter {
    requests = []
    handles = []
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      this.requests.push(options)
      let chunks
      if (this.requests.length === 1) chunks = call('multi-output', 'multi_fixture', {})
      else if (this.requests.length === 2) {
        const blocks = options.messages.filter(message => message.role === 'tool').at(-1).content
        this.handles = blocks.map(block => /handle=(cmw_[a-f0-9]{48})/.exec(block.text ?? '')?.[1])
        if (this.handles[0] && this.handles[3]) await service.stop()
        chunks = this.handles[0] && this.handles[3] ? call('recover-first', 'caveman_retrieve', { handle: this.handles[0] }) : [{ type: 'finish', reason: { kind: 'stop' } }]
      } else if (this.requests.length === 3) chunks = call('recover-second', 'caveman_retrieve', { handle: this.handles[3] })
      else chunks = [{ type: 'finish', reason: { kind: 'stop' } }]
      for (const chunk of chunks) yield chunk
    }
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
    await ctx.plugin(plugin, { defaultMode: 'manual', middlewareEndpoint: service.endpoint })
    ctx.tools.register(defineTool({
      name: 'multi_fixture', description: 'Return several text blocks.', parameters: {},
      output: { schema: { type: 'string' }, render: () => [
        { type: 'text', text: original }, { type: 'text', text: 'short block' },
        { type: 'reasoning', text: 'other block' }, { type: 'text', text: second },
      ] },
      async execute() { return 'fixture' },
    }))
    const adapter = new MultiAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create('multi-compression-session', { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the sample.' }] }))
    await agent.whenIdle()
    assert.equal(adapter.requests.length, 4, 'both original blocks can be recovered after the runtime stops')
    const compressed = adapter.requests[1].messages.filter(message => message.role === 'tool').at(-1).content
    assert.equal(compressed.length, 4)
    assert.ok(compressed[0].text.length < original.length / 4)
    assert.equal(compressed[1].text, 'short block')
    assert.deepEqual(compressed[2], { type: 'reasoning', text: 'other block' })
    assert.ok(compressed[3].text.length < second.length / 4)
    const firstRecovery = adapter.requests[2].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    const secondRecovery = adapter.requests[3].messages.filter(message => message.role === 'tool').at(-1).content[0].text
    assert.equal(JSON.parse(firstRecovery).text, original)
    assert.equal(JSON.parse(secondRecovery).text, second)
    const surface = agent.session.surface.nodes.map(seq => agent.session.eventAt(seq))
    const visible = surface.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'multi-output')
    assert.deepEqual(visible.data.message.content, [
      { type: 'text', text: original }, { type: 'text', text: 'short block' },
      { type: 'reasoning', text: 'other block' }, { type: 'text', text: second },
    ])
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    await service.close()
  }
})

test('multiple tool results share an optimization request', { skip: !proxyBinary }, async t => {
  const service = await startProxy()
  const previousHome = process.env.CAVEMAN_HOME
  process.env.CAVEMAN_HOME = service.home
  let optimizeCalls = 0
  const destination = new URL(service.endpoint)
  const relay = createHttpServer((incoming, outgoing) => {
    if (incoming.url?.endsWith('/optimize')) optimizeCalls++
    const request = httpRequest({ hostname: destination.hostname, port: destination.port, path: incoming.url, method: incoming.method, headers: incoming.headers, agent: false }, response => {
      outgoing.writeHead(response.statusCode ?? 500, response.headers)
      response.pipe(outgoing)
    })
    request.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
    incoming.pipe(request)
  })
  await new Promise((resolve, reject) => relay.listen(0, '127.0.0.1', resolve).on('error', reject))
  const endpoint = `http://127.0.0.1:${relay.address().port}`
  const ctx = new Context()
  class BatchAdapter extends LlmAdapter {
    requests = []
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      this.requests.push(options)
      if (this.requests.length === 1) {
        for (let index = 0; index < 8; index++) {
          const id = `batch-${index}`
          const args = JSON.stringify({ index })
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: 'batch_fixture', argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'batch_fixture', arguments: args } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else yield { type: 'finish', reason: { kind: 'stop' } }
    }
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
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: true, middlewareEndpoint: endpoint })
    ctx.tools.register(defineTool({
      name: 'batch_fixture', description: 'Return a large log.', parameters: { index: { type: 'integer', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) { return original.replaceAll('/api/test', `/api/test/${args.index}`) },
    }))
    const adapter = new BatchAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create('batch-compression-session', { provider: 'mock', model: 'mock' })
    const started = performance.now()
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the logs.' }] }))
    await agent.whenIdle()
    const elapsed = performance.now() - started
    const messages = adapter.requests[1].messages.filter(message => message.role === 'tool')
    assert.equal(messages.length, 8)
    assert.ok(messages.every(message => message.content[0].text.length < original.length / 4))
    const capabilities = await (await fetch(`${service.endpoint}/caveman/v1/middleware/capabilities`)).json()
    t.diagnostic(`8 results: ${optimizeCalls} optimization requests, ${elapsed.toFixed(1)} ms; limits ${JSON.stringify(capabilities.limits)}`)
    assert.equal(optimizeCalls, 1)
    const originals = agent.session.surface.nodes.map(seq => agent.session.eventAt(seq))
      .filter(event => event.type === 'tool/result' && event.data.message.toolCallId.startsWith('batch-'))
    assert.equal(originals.length, 8)
    assert.ok(originals.every(event => event.data.message.content[0].text.length > original.length))
    await service.stop()
    for (const index of [0, 7]) {
      const handle = /handle=(cmw_[a-f0-9]{48})/.exec(messages[index].content[0].text)?.[1]
      assert.ok(handle)
      const recovered = await ctx.tools.execute({
        agent, signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: `recover-${index}`, name: 'caveman_retrieve', arguments: JSON.stringify({ handle }) }],
      })
      assert.equal(recovered.results[0].result.isError, false)
      assert.equal(JSON.parse(recovered.results[0].result.content[0].text).text, original.replaceAll('/api/test', `/api/test/${index}`))
    }
  } finally {
    await ctx.fiber.dispose()
    await new Promise(resolve => relay.close(resolve))
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    await service.close()
  }
})

test('a changing session surface invalidates an in-flight compression plan', { skip: !proxyBinary }, async () => {
  const service = await startProxy()
  const previousHome = process.env.CAVEMAN_HOME
  process.env.CAVEMAN_HOME = service.home
  const destination = new URL(service.endpoint)
  let agent
  let changed = false
  const relay = createHttpServer((incoming, outgoing) => {
    if (!changed && incoming.url?.endsWith('/optimize')) {
      changed = true
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Concurrent session update.' }] }), { surfaceOp: 'append' })
    }
    const request = httpRequest({ hostname: destination.hostname, port: destination.port, path: incoming.url, method: incoming.method, headers: incoming.headers, agent: false }, response => {
      outgoing.writeHead(response.statusCode ?? 500, response.headers)
      response.pipe(outgoing)
    })
    request.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
    incoming.pipe(request)
  })
  await new Promise((resolve, reject) => relay.listen(0, '127.0.0.1', resolve).on('error', reject))
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
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: true, middlewareEndpoint: `http://127.0.0.1:${relay.address().port}` })
    ctx.tools.register(defineTool({
      name: 'large_fixture', description: 'Return a large log.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return original },
    }))
    const adapter = new LocalAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    agent = await ctx.agentLoop.create('changing-compression-session', { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the log.' }] }))
    await agent.whenIdle()
    assert.equal(changed, true)
    assert.equal(adapter.requests.length, 2)
    const result = adapter.requests[1].messages.find(message => message.role === 'tool' && message.toolCallId === 'output-call')
    assert.equal(result.content[0].text, original)
    assert.ok(adapter.requests[1].messages.some(message => message.role === 'user' && message.content.some(block => block.text === 'Concurrent session update.')))
  } finally {
    await ctx.fiber.dispose()
    await new Promise(resolve => relay.close(resolve))
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    await service.close()
  }
})

test('recovery tool outputs are not compressed again', { skip: !proxyBinary }, async () => {
  const service = await startProxy()
  const previousHome = process.env.CAVEMAN_HOME
  process.env.CAVEMAN_HOME = service.home
  const ctx = new Context()
  const names = ['mcp__caveman__caveman_retrieve', 'mcp__caveman_browse__browser_recover', 'mcp__caveman__caveman_toon_decode', 'mcp__cavemem__cavemem_recall', 'cavemem_recover']
  class RecoveryAdapter extends LlmAdapter {
    requests = []
    constructor(name) { super(); this.name = name }
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      this.requests.push(options)
      const chunks = this.requests.length === 1 ? call('recovery-output', this.name, {}) : [{ type: 'finish', reason: { kind: 'stop' } }]
      for (const chunk of chunks) yield chunk
    }
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
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: true, middlewareEndpoint: service.endpoint })
    for (const [index, name] of names.entries()) {
      ctx.tools.register(defineTool({
        name, description: 'Return recovered content.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return original },
      }))
      const adapter = new RecoveryAdapter(name)
      const provider = `recover-${index}`
      ctx.llm.registerAdapter([provider], adapter)
      const agent = await ctx.agentLoop.create(`recovery-tool-${index}`, { provider, model: 'mock' })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Recover the content.' }] }))
      await agent.whenIdle()
      const result = adapter.requests[1].messages.find(message => message.role === 'tool' && message.toolCallId === 'recovery-output')
      assert.equal(result.content[0].text, original, `${name} returns the requested original`)
    }
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    await service.close()
  }
})

test('the original remains recoverable from the session if the proxy stops', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(true)
})

test('a restricted recovery tool prevents shortening', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(false, true)
})

test('a transient restore error does not strand compressed content on the session surface', { skip: !proxyBinary }, async () => {
  await exerciseRecovery(false, false, true)
})
