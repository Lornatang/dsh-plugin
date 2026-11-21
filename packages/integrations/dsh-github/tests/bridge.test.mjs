import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { GithubBridge, publicToolName } from '../lib/bridge.js'
import { SessionStore, sessionFileFor } from '../lib/store.js'
import { createGithubFetch } from '../lib/transport.js'
import { startMockMcp } from './mock-mcp.mjs'

process.env.DSH_GITHUB_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64')
const logger = { info() {}, warn() {}, error() {} }

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-test-'))
  const mock = await startMockMcp(options)
  const definitions = new Map()
  const file = sessionFileFor('github', mock.url, join(root, 'cordis.patch.yml'))
  const config = { serverName: 'github', url: mock.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', store: new SessionStore(file) }
  const host = { logger, register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } }
  const bridge = new GithubBridge(host, config)
  return { root, mock, file, definitions, config, host, bridge, async close() { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) } }
}

test('connects, registers read/write tools, redacts credentials and restores encrypted state', async () => {
  const f = await fixture()
  try {
    await f.bridge.start()
    assert.equal(f.bridge.snapshot().status, 'idle')
    const status = await f.bridge.connect({ source: 'token', token: 'testtoken' })
    assert.equal(status.status, 'ready')
    assert.equal(status.toolCount, 3)
    assert.equal(f.bridge.requiresApproval('mcp__github__get_file_contents'), false)
    assert.equal(f.bridge.requiresApproval('mcp__github__push_files'), true)
    assert.equal(f.bridge.requiresApproval('mcp__github__unknown_tool'), true)
    assert.equal(f.mock.requests[0].authorization, 'Bearer testtoken')
    assert.equal(f.mock.requests[0].toolsets, 'repos,issues')
    const read = f.definitions.get('mcp__github__get_file_contents')
    const result = await read.execute({ path: 'README.md' }, { signal: new AbortController().signal })
    assert.match(result.content[0].text, /README\.md \[REDACTED\]/)
    await assert.rejects(read.execute({ path: 'fail' }, {}), /Permission denied for \[REDACTED\]/)
    assert.doesNotMatch(await readFile(f.file, 'utf8'), /testtoken/)
    await f.bridge.dispose()
    const restored = new GithubBridge(f.host, { ...f.config, store: new SessionStore(f.file) })
    await restored.start()
    assert.equal(restored.snapshot().status, 'ready')
    assert.equal((await restored.disconnect()).status, 'idle')
    assert.equal(f.definitions.size, 0)
    await restored.dispose()
  } finally { await f.close() }
})

test('a rejected token does not overwrite a working saved credential', async () => {
  const f = await fixture()
  try {
    await f.bridge.start()
    assert.equal((await f.bridge.connect({ source: 'token', token: 'testtoken' })).status, 'ready')
    assert.equal((await f.bridge.connect({ source: 'token', token: 'badtoken' })).status, 'error')
    await f.bridge.dispose()
    const restored = new GithubBridge(f.host, { ...f.config, store: new SessionStore(f.file) })
    await restored.start()
    assert.equal(restored.snapshot().status, 'ready')
    await restored.dispose()
  } finally { await f.close() }
})

test('redacts a complete token even when an earlier credential is its prefix', async () => {
  const f = await fixture({ token: 'gho_ExampleSecretValue' })
  try {
    await f.bridge.start()
    assert.equal((await f.bridge.connect({ source: 'token', token: 'gho_' })).status, 'error')
    assert.equal((await f.bridge.connect({ source: 'token', token: 'gho_ExampleSecretValue' })).status, 'ready')
    const result = await f.definitions.get('mcp__github__get_file_contents').execute({ path: 'README.md' }, {})
    assert.match(result.content[0].text, /\[REDACTED\]/)
    assert.doesNotMatch(result.content[0].text, /ExampleSecretValue/)
  } finally { await f.close() }
})

test('redacts strings without corrupting numeric content annotations', async () => {
  const f = await fixture({ token: 'validtoken', contentAnnotations: true })
  try {
    await f.bridge.start()
    assert.equal((await f.bridge.connect({ source: 'token', token: '1' })).status, 'error')
    assert.equal((await f.bridge.connect({ source: 'token', token: 'validtoken' })).status, 'ready')
    const result = await f.definitions.get('mcp__github__get_file_contents').execute({ path: 'README.md' }, {})
    assert.equal(result.content[0].annotations.priority, 1)
    assert.match(result.content[0].text, /\[REDACTED\]/)
  } finally { await f.close() }
})

test('a rejected credential does not corrupt future content metadata or text', async () => {
  const f = await fixture({ token: 'validtoken' })
  try {
    await f.bridge.start()
    assert.equal((await f.bridge.connect({ source: 'token', token: 'text' })).status, 'error')
    assert.equal((await f.bridge.connect({ source: 'token', token: 'validtoken' })).status, 'ready')
    const result = await f.definitions.get('mcp__github__get_file_contents').execute({ path: 'text.txt' }, {})
    assert.equal(result.content[0].type, 'text')
    assert.equal(result.content[0].text, 'Read text.txt [REDACTED]')
  } finally { await f.close() }
})

test('redacts structured-only results before serializing numeric values', async () => {
  const f = await fixture({ token: 'validtoken', structured: true, structuredOnly: true })
  try {
    await f.bridge.start()
    assert.equal((await f.bridge.connect({ source: 'token', token: '1' })).status, 'error')
    assert.equal((await f.bridge.connect({ source: 'token', token: 'validtoken' })).status, 'ready')
    const result = await f.definitions.get('mcp__github__structured').execute({ bad: false }, {})
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, count: 1 })
  } finally { await f.close() }
})

test('preserves MCP structure when the active credential is a short common value', async () => {
  const f = await fixture({ token: 'text' })
  try {
    await f.bridge.start()
    assert.equal((await f.bridge.connect({ source: 'token', token: 'text' })).status, 'ready')
    const result = await f.definitions.get('mcp__github__get_file_contents').execute({ path: 'text.txt' }, {})
    assert.equal(result.content[0].type, 'text')
    assert.equal(result.content[0].text, 'Read [REDACTED].txt [REDACTED]')
  } finally { await f.close() }
})

test('redacts nested keys and values without revisiting or copying clean branches', async (t) => {
  const f = await fixture({ token: 'text' })
  try {
    assert.equal((await f.bridge.connect({ source: 'token', token: 'text' })).status, 'ready')
    let reads = 0
    const clean = { get value() { reads++; return [0, false, null] } }
    const details = { clean, nested: { 'secret-text': 'text' } }
    const content = [{ type: 'text', text: 'safe', details }]
    t.mock.method(Client.prototype, 'callTool', async () => ({ content }))
    const result = await f.definitions.get('mcp__github__get_file_contents').execute({}, {})
    assert.equal(reads, 1)
    assert.notEqual(result.content, content)
    assert.notEqual(result.content[0].details, details)
    assert.equal(result.content[0].details.clean, clean)
    assert.deepEqual(result.content[0].details.nested, { 'secret-[REDACTED]': '[REDACTED]' })
    assert.deepEqual(details.nested, { 'secret-text': 'text' })
    assert.equal(result.content[0].type, 'text')
    assert.equal(result.content[0].text, 'safe')
  } finally { await f.close() }
})

test('keeps structured numbers intact when they match the active credential', async () => {
  const f = await fixture({ token: '1', structured: true, structuredOnly: true })
  try {
    await f.bridge.start()
    assert.equal((await f.bridge.connect({ source: 'token', token: '1' })).status, 'ready')
    const result = await f.definitions.get('mcp__github__structured').execute({ bad: false }, {})
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, count: 1 })
  } finally { await f.close() }
})

test('disconnect cancels an in-flight connection and prevents stale registration', async () => {
  const f = await fixture({ initializeDelay: 250 })
  try {
    await f.bridge.start()
    const connecting = f.bridge.connect({ source: 'token', token: 'testtoken' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const disconnected = await f.bridge.disconnect()
    await connecting
    assert.equal(disconnected.status, 'idle')
    assert.equal(f.definitions.size, 0)
  } finally { await f.close() }
})

test('rejects duplicate tools, unsafe origins and credential-bearing redirects', async () => {
  const f = await fixture({ duplicate: true })
  try {
    await f.bridge.start()
    assert.equal((await f.bridge.connect({ source: 'token', token: 'testtoken' })).status, 'error')
    assert.equal(f.definitions.size, 0)
    assert.throws(() => createGithubFetch(new URL('http://example.com/mcp'), 'testtoken', '', false), /HTTPS/)
    const fetch = createGithubFetch(new URL(f.mock.url), 'testtoken', '', false)
    await assert.rejects(fetch('http://example.com/mcp'), /origin/)
    assert.notEqual(publicToolName('github', 'a/b'), publicToolName('github', 'a_b'))
  } finally { await f.close() }
})

test('refuses a missing profile and drops stored fields of an unknown source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-store-'))
  try {
    assert.throws(() => sessionFileFor('github', 'https://api.githubcopilot.com/mcp/'), /active DSH profile is unknown/)
    const file = sessionFileFor('github', 'https://api.githubcopilot.com/mcp/', join(root, 'cordis.patch.yml'))
    const store = new SessionStore(file)
    await store.load()
    await store.patch({ source: 'env', token: 'testtoken' })
    const restored = new SessionStore(file)
    const loaded = await restored.load()
    assert.equal(loaded.source, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('read-only mode and a missing approval hook only register read-only tools', async () => {
  const f = await fixture()
  try {
    const readonly = new GithubBridge(f.host, { ...f.config, readOnly: true, store: new SessionStore(f.file) })
    await readonly.start()
    assert.equal((await readonly.connect({ source: 'token', token: 'testtoken' })).status, 'ready')
    assert.equal(readonly.requiresApproval('mcp__github__push_files'), false)
    assert(f.definitions.has('mcp__github__get_file_contents'))
    assert(!f.definitions.has('mcp__github__push_files'))
    await readonly.dispose()
    const guarded = new GithubBridge(f.host, { ...f.config, approvalHook: false, store: new SessionStore(f.file) })
    await guarded.start()
    assert.equal((await guarded.connect({ source: 'token', token: 'testtoken' })).status, 'ready')
    assert(!f.definitions.has('mcp__github__push_files'))
    assert(f.definitions.has('mcp__github__get_file_contents'))
    await guarded.dispose()
  } finally { await f.close() }
})

test('tool errors keep cancellation identity', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.bridge.connect({ source: 'token', token: 'testtoken' })).status, 'ready')
    const read = f.definitions.get('mcp__github__get_file_contents')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(read.execute({ path: 'README.md' }, { signal: controller.signal }), (error) => error?.name === 'AbortError')
  } finally { await f.close() }
})

test('validates structured output and passes read-only mode to GitHub', async () => {
  const f = await fixture({ structured: true })
  const bridge = new GithubBridge(f.host, { ...f.config, readOnly: true, store: new SessionStore(f.file) })
  try {
    await bridge.start()
    assert.equal((await bridge.connect({ source: 'token', token: 'testtoken' })).status, 'ready')
    assert.equal(f.mock.requests[0].readOnly, 'true')
    const tool = f.definitions.get('mcp__github__structured')
    assert.equal((await tool.execute({ bad: false }, {})).content[0].text, 'structured')
    await assert.rejects(tool.execute({ bad: true }, {}), /structured output does not match/)
  } finally { await bridge.dispose(); await f.close() }
})

test('reports the package version and forwards only plain-object arguments', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.bridge.connect({ source: 'token', token: 'testtoken' })).status, 'ready')
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(f.mock.state.clientInfo.version, pkg.version)
    const push = f.definitions.get('mcp__github__push_files')
    await push.execute(['not', 'an', 'object'], {})
    assert.deepEqual(f.mock.calls.at(-1).arguments, {})
    await push.execute(null, {})
    assert.deepEqual(f.mock.calls.at(-1).arguments, {})
    await push.execute({ ok: true }, {})
    assert.deepEqual(f.mock.calls.at(-1).arguments, { ok: true })
  } finally { await f.close() }
})

test('redacts credentials from multi-megabyte tool output in one pass', async () => {
  const f = await fixture({ largeText: 2_000_000 })
  try {
    assert.equal((await f.bridge.connect({ source: 'token', token: 'testtoken' })).status, 'ready')
    const read = f.definitions.get('mcp__github__get_file_contents')
    const result = await read.execute({ path: 'big' }, {})
    const text = result.content[0].text
    assert.ok(text.endsWith('[REDACTED]'))
    assert.ok(!text.includes('testtoken'))
    assert.equal(text.length, 2_000_000 + 1 + '[REDACTED]'.length)
  } finally { await f.close() }
})

test('workflow scope refusals pass through unchanged for non-OAuth credentials', async () => {
  const f = await fixture({ workflowRefusal: true })
  try {
    await f.bridge.start()
    assert.equal((await f.bridge.connect({ source: 'token', token: 'testtoken' })).status, 'ready')
    await assert.rejects(f.definitions.get('mcp__github__push_files').execute({}, {}), /without `workflow` scope/)
    assert.equal(f.bridge.snapshot().requiredScopes, undefined)
  } finally { await f.close() }
})
