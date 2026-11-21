import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { apply } from '../lib/index.js'
import { registerRoutes } from '../lib/routes.js'
import { startMockMcp } from './mock-mcp.mjs'

process.env.DSH_GITHUB_ENCRYPTION_KEY = Buffer.alloc(32, 18).toString('base64')

test('browser authorization and cancellation use separate fenced routes', async () => {
  let route
  let received
  let cancelled = false
  let disconnected = false
  const snapshot = { status: 'idle', toolCount: 0, readOnly: false, oauthAvailable: true }
  const bridge = {
    snapshot: () => snapshot,
    async connect(input) { received = input; return snapshot },
    async cancel() { cancelled = true; return snapshot },
    async disconnect() { disconnected = true; return snapshot },
  }
  registerRoutes({ register(value) { route = value; return () => {} } }, bridge, { requestRejection: () => undefined })
  const server = createServer((req, res) => void route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/plugins/github`
  try {
    const invalid = await fetch(base + '/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'oauth', token: 'unexpected' }) })
    assert.equal(invalid.status, 400)
    const response = await fetch(base + '/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'oauth' }) })
    assert.equal(response.status, 200)
    assert.deepEqual(received, { source: 'oauth' })
    assert.equal((await fetch(base + '/cancel', { method: 'POST' })).status, 200)
    assert.equal(cancelled, true)
    assert.equal(disconnected, false)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('routes require the DSH fence and write tools request approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-routes-'))
  const mock = await startMockMcp()
  let route
  let fence
  const handlers = new Map()
  const cleanup = []
  const ctx = {
    tools: { register: () => () => {} }, logger: { info() {}, warn() {}, error() {} },
    profileContext: { patchPath: join(root, 'cordis.patch.yml') },
    get: (name) => name === 'webServer' ? web : name === 'connection' ? fence : undefined,
    on: (name, listener) => { handlers.set(name, listener); return () => handlers.delete(name) },
    effect: (setup) => { cleanup.push(setup()) },
  }
  const web = { register(value) { route = value; return () => { if (route === value) route = undefined } } }
  const server = createServer((req, res) => route ? void route.handler(req, res) : res.writeHead(404).end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/plugins/github`
  try {
    apply(ctx, { serverName: 'github', url: mock.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved' })
    assert.equal((await fetch(base + '/status')).status, 503)
    fence = { requestRejection: () => 401 }
    handlers.get('internal/service')('connection')
    assert.equal((await fetch(base + '/status')).status, 401)
    fence = { requestRejection: () => undefined }
    handlers.get('internal/service')('connection')
    const invalid = await fetch(base + '/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'token', token: 'testtoken', extra: true }) })
    assert.equal(invalid.status, 400)
    const response = await fetch(base + '/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'token', token: 'testtoken' }) })
    const status = await response.json()
    assert.equal(status.status, 'ready')
    assert.doesNotMatch(JSON.stringify(status), /testtoken/)
    const pre = handlers.get('tools/pre-execute')
    const allow = async () => ({ kind: 'allow' })
    assert.equal((await pre({ name: 'mcp__github__push_files' }, allow)).kind, 'ask')
    assert.equal((await pre({ name: 'mcp__github__get_file_contents' }, allow)).kind, 'allow')
    assert.equal((await pre({ name: 'mcp__github__push_files' }, async () => ({ kind: 'deny', reason: 'denied' }))).kind, 'deny')
    assert.equal((await fetch(base + '/disconnect', { method: 'POST' })).status, 200)
  } finally {
    for (const dispose of cleanup.reverse()) await dispose?.()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('real DSH tool pipeline dispatches reads and denies writes without an approval channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-policy-'))
  const mock = await startMockMcp()
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} })
  new ToolsService(ctx)
  let route
  ctx.provide('webServer', { register(value) { route = value; return () => { route = undefined } } })
  ctx.provide('connection', { requestRejection: () => undefined })
  const pluginCtx = ctx.extend({ profileContext: { patchPath: join(root, 'cordis.patch.yml') } })
  const server = createServer((req, res) => route ? void route.handler(req, res) : res.writeHead(404).end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/plugins/github`
  try {
    apply(pluginCtx, { serverName: 'github', url: mock.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved' })
    const connected = await fetch(base + '/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'token', token: 'testtoken' }) })
    assert.equal((await connected.json()).status, 'ready')
    const pipeline = new ToolExecutionPipeline(ctx)
    const signal = new AbortController().signal
    const read = await pipeline.prepare({ callId: 'read', name: 'mcp__github__get_file_contents', arguments: { path: 'README.md' }, signal })
    assert.equal(read.kind, 'dispatch')
    const dispatched = await pipeline.dispatch(read.exec)
    const result = await pipeline.complete(read.exec, dispatched)
    assert.equal(result.isError, false)
    assert.match(result.content[0].text, /README\.md/)
    const write = await pipeline.prepare({ callId: 'write', name: 'mcp__github__push_files', arguments: {}, signal })
    assert.equal(write.kind, 'post-result')
    assert.equal(write.result.error.info.code, 'APPROVAL_UNAVAILABLE')
    await fetch(base + '/disconnect', { method: 'POST' })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
})
