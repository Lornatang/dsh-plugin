import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { GithubBridge } from '../lib/bridge.js'
import { parseRequestedScopes } from '../lib/oauth.js'
import { SessionStore, sessionFileFor } from '../lib/store.js'
import { startMockMcp } from './mock-mcp.mjs'

process.env.DSH_GITHUB_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64')

async function waitUntil(predicate, timeout = 4000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for connection')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('browser authorization connects and restores the encrypted session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-'))
  const mcp = await startMockMcp()
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const registered = new Map()
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store: new SessionStore(file) }
  const host = { logger: { info() {}, warn() {}, error() {} }, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  let pollCount = 0
  globalThis.fetch = async (value, init) => {
    const url = new URL(value)
    if (url.origin !== 'https://github.com') return originalFetch(value, init)
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    const body = new URLSearchParams(init.body)
    assert.equal(body.get('client_id'), 'Iv1.testClientId')
    if (url.pathname === '/login/device/code') {
      return Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 })
    }
    assert.equal(url.pathname, '/login/oauth/access_token')
    assert.equal(body.get('device_code'), 'secret-device-code')
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
    pollCount++
    return Response.json({ access_token: 'testtoken', token_type: 'bearer' })
  }
  let restored
  try {
    await bridge.start()
    const pending = await bridge.connect({ source: 'oauth' })
    assert.equal(pending.status, 'authorizing')
    assert.deepEqual(pending.authorization, { userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device' })
    assert.doesNotMatch(JSON.stringify(pending), /secret-device-code|testtoken/)
    await waitUntil(() => bridge.snapshot().status === 'ready')
    assert.equal(pollCount, 1)
    assert.equal(mcp.requests[0].authorization, 'Bearer testtoken')
    assert.equal(registered.size, 3)
    assert.doesNotMatch(await readFile(file, 'utf8'), /testtoken|secret-device-code/)
    await bridge.dispose()
    restored = new GithubBridge(host, { ...config, store: new SessionStore(file) })
    await restored.start()
    assert.equal(restored.snapshot().status, 'ready')
    assert.equal(restored.snapshot().source, 'oauth')
    assert.equal(pollCount, 1)
  } finally {
    globalThis.fetch = originalFetch
    await restored?.dispose()
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelling browser authorization prevents subsequent token polling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-cancel-'))
  const mcp = await startMockMcp()
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const host = { logger: { info() {}, warn() {}, error() {} }, register() { return () => {} } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store: new SessionStore(file) }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  let pollCount = 0
  globalThis.fetch = async (value, init) => {
    const url = new URL(value)
    if (url.origin !== 'https://github.com') return originalFetch(value, init)
    if (url.pathname === '/login/device/code') return Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 })
    pollCount++
    return Response.json({ access_token: 'testtoken', token_type: 'bearer' })
  }
  try {
    await bridge.start()
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    assert.equal(typeof bridge.cancel, 'function')
    assert.equal((await bridge.cancel()).status, 'idle')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(pollCount, 0)
    assert.equal(bridge.snapshot().status, 'idle')
    assert.equal(mcp.requests.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelling browser authorization restores the previously saved connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-preserve-'))
  const mcp = await startMockMcp()
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const store = new SessionStore(file)
  const registered = new Map()
  const host = { logger: { info() {}, warn() {}, error() {} }, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (value, init) => new URL(value).origin === 'https://github.com'
    ? Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 })
    : originalFetch(value, init)
  try {
    await bridge.start()
    assert.equal((await bridge.connect({ source: 'token', token: 'testtoken' })).status, 'ready')
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    assert.equal(typeof bridge.cancel, 'function')
    const cancelled = await bridge.cancel()
    assert.equal(cancelled.status, 'ready')
    assert.equal(cancelled.source, 'token')
    assert.equal(registered.size, 3)
    const reloaded = new SessionStore(file)
    await reloaded.load()
    assert.equal(reloaded.current.token, 'testtoken')
    assert.equal(reloaded.current.source, 'token')
  } finally {
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancel restores the active manual connection even with an environment default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-cancel-source-'))
  const mcp = await startMockMcp({ token: ['envtoken', 'manualtoken'] })
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const store = new SessionStore(file)
  const host = { logger: { info() {}, warn() {}, error() {} }, register() { return () => {} } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'env', oauthClientId: 'Iv1.testClientId', store }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  const originalToken = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'envtoken'
  globalThis.fetch = async (value, init) => new URL(value).origin === 'https://github.com'
    ? Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 })
    : originalFetch(value, init)
  try {
    await bridge.start()
    assert.equal(bridge.snapshot().source, 'env')
    assert.equal((await bridge.connect({ source: 'token', token: 'manualtoken' })).status, 'ready')
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    const cancelled = await bridge.cancel()
    assert.equal(cancelled.status, 'ready')
    assert.equal(cancelled.source, 'token')
    assert.equal(mcp.requests.at(-1).authorization, 'Bearer manualtoken')
  } finally {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalToken
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancel during credential commit restores the original saved connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-cancel-commit-'))
  const mcp = await startMockMcp({ token: ['oldtoken', 'newtoken'] })
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const stored = new SessionStore(file)
  let savingOAuth = false
  let releaseSave
  const store = {
    get current() { return stored.current },
    load: () => stored.load(),
    destroy: () => stored.destroy(),
    async patch(patch, active) {
      if (patch.source === 'oauth') {
        assert.equal(active(), true)
        savingOAuth = true
        await new Promise((resolve) => { releaseSave = resolve })
        return stored.patch(patch)
      }
      return stored.patch(patch, active)
    },
  }
  const host = { logger: { info() {}, warn() {}, error() {} }, register() { return () => {} } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (value, init) => {
    const url = new URL(value)
    if (url.origin !== 'https://github.com') return originalFetch(value, init)
    if (url.pathname === '/login/device/code') return Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 })
    return Response.json({ access_token: 'newtoken', token_type: 'bearer' })
  }
  try {
    await bridge.start()
    assert.equal((await bridge.connect({ source: 'token', token: 'oldtoken' })).status, 'ready')
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    await waitUntil(() => savingOAuth)
    const pendingCancel = bridge.cancel()
    await new Promise((resolve) => setTimeout(resolve, 25))
    releaseSave()
    const cancelled = await pendingCancel
    assert.equal(cancelled.status, 'ready')
    assert.equal(cancelled.source, 'token')
    const reloaded = new SessionStore(file)
    await reloaded.load()
    assert.equal(reloaded.current.source, 'token')
    assert.equal(reloaded.current.token, 'oldtoken')
    assert.equal(mcp.requests.at(-1).authorization, 'Bearer oldtoken')
  } finally {
    releaseSave?.()
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('refreshes an expired browser authorization before reconnecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-refresh-'))
  const mcp = await startMockMcp()
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const store = new SessionStore(file)
  await store.patch({ source: 'oauth', token: 'expiredtoken', oauthRefreshToken: 'oldrefreshtoken', oauthExpiresAt: Date.now() - 1000, oauthClientId: 'Iv1.testClientId' })
  const host = { logger: { info() {}, warn() {}, error() {} }, register() { return () => {} } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  let refreshCount = 0
  globalThis.fetch = async (value, init) => {
    const url = new URL(value)
    if (url.origin !== 'https://github.com') return originalFetch(value, init)
    assert.equal(url.pathname, '/login/oauth/access_token')
    const body = new URLSearchParams(init.body)
    assert.equal(body.get('grant_type'), 'refresh_token')
    assert.equal(body.get('client_id'), 'Iv1.testClientId')
    assert.equal(body.get('refresh_token'), 'oldrefreshtoken')
    refreshCount++
    return Response.json({ access_token: 'testtoken', token_type: 'bearer', expires_in: 3600, refresh_token: 'newrefreshtoken' })
  }
  try {
    await bridge.start()
    assert.equal(bridge.snapshot().status, 'ready')
    assert.equal(refreshCount, 1)
    assert.equal(mcp.requests[0].authorization, 'Bearer testtoken')
    const reloaded = new SessionStore(file)
    await reloaded.load()
    assert.equal(reloaded.current.token, 'testtoken')
    assert.equal(reloaded.current.oauthRefreshToken, 'newrefreshtoken')
    assert.doesNotMatch(await readFile(file, 'utf8'), /testtoken|refreshtoken/)
  } finally {
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('refreshes an expiring token once for concurrent tool calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-active-refresh-'))
  const mcp = await startMockMcp({ token: ['oldtoken', 'newtoken'] })
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const store = new SessionStore(file)
  await store.patch({ source: 'oauth', token: 'oldtoken', oauthRefreshToken: 'oldrefreshtoken', oauthExpiresAt: Date.now() + 120000, oauthClientId: 'Iv1.testClientId' })
  const registered = new Map()
  const host = { logger: { info() {}, warn() {}, error() {} }, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let refreshCount = 0
  globalThis.fetch = async (value, init) => {
    if (new URL(value).origin !== 'https://github.com') return originalFetch(value, init)
    assert.equal(new URLSearchParams(init.body).get('grant_type'), 'refresh_token')
    refreshCount++
    await new Promise((resolve) => setTimeout(resolve, 25))
    return Response.json({ access_token: 'newtoken', token_type: 'bearer', expires_in: 3600, refresh_token: 'newrefreshtoken' })
  }
  try {
    await bridge.start()
    assert.equal(bridge.snapshot().status, 'ready')
    Date.now = () => originalNow() + 90000
    const read = registered.get('mcp__github__get_file_contents')
    const results = await Promise.all([read.execute({ path: 'one' }, {}), read.execute({ path: 'two' }, {})])
    assert.equal(refreshCount, 1)
    for (const result of results) assert.match(result.content[0].text, /\[REDACTED\]/)
    assert.equal(mcp.requests.filter((request) => request.authorization === 'Bearer newtoken').length, 2)
    const reloaded = new SessionStore(file)
    await reloaded.load()
    assert.equal(reloaded.current.token, 'newtoken')
    assert.equal(reloaded.current.oauthRefreshToken, 'newrefreshtoken')
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses an unexpected verification URL without exposing device credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-url-'))
  const mcp = await startMockMcp()
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const host = { logger: { info() {}, warn() {}, error() {} }, register() { return () => {} } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store: new SessionStore(file) }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://example.com/login/device', expires_in: 30, interval: 1 })
  try {
    await bridge.start()
    const result = await bridge.connect({ source: 'oauth' })
    assert.equal(result.status, 'error')
    assert.match(result.error, /invalid response/)
    assert.doesNotMatch(JSON.stringify(result), /secret-device-code|example.com/)
    assert.equal(result.authorization, undefined)
  } finally {
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('asks the user to reconnect when a saved authorization cannot be refreshed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-bad-refresh-'))
  const mcp = await startMockMcp()
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const store = new SessionStore(file)
  await store.patch({ source: 'oauth', token: 'testtoken', oauthRefreshToken: 'expiredrefresh', oauthExpiresAt: Date.now() + 120000, oauthClientId: 'Iv1.testClientId' })
  const registered = new Map()
  const host = { logger: { info() {}, warn() {}, error() {} }, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const originalClose = Client.prototype.close
  let closeCalls = 0
  Client.prototype.close = async function (...args) { closeCalls += 1; return originalClose.apply(this, args) }
  globalThis.fetch = async (value, init) => new URL(value).origin === 'https://github.com'
    ? Response.json({ error: 'bad_refresh_token' }) : originalFetch(value, init)
  try {
    await bridge.start()
    assert.equal(bridge.snapshot().status, 'ready')
    const read = registered.get('mcp__github__get_file_contents')
    Date.now = () => originalNow() + 90000
    await assert.rejects(read.execute({ path: 'one' }, {}), /authorization expired; connect again/)
    assert.equal(bridge.snapshot().status, 'error')
    assert.match(bridge.snapshot().error, /authorization expired; connect again/)
    // A failed refresh must also shut the MCP client down, not leave the
    // transport open behind cleared tools. close() aborts the transport
    // without an HTTP request, so observe it on the SDK prototype.
    await waitUntil(() => closeCalls > 0)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    Client.prototype.close = originalClose
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps rotated credentials usable and retries a temporary storage failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-save-retry-'))
  const mcp = await startMockMcp({ token: ['oldtoken', 'newtoken'] })
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const stored = new SessionStore(file)
  await stored.patch({ source: 'oauth', token: 'oldtoken', oauthRefreshToken: 'oldrefreshtoken', oauthExpiresAt: Date.now() + 120000, oauthClientId: 'Iv1.testClientId' })
  let failOnce = true
  const store = {
    get current() { return stored.current },
    load: () => stored.load(),
    destroy: () => stored.destroy(),
    patch: (...args) => {
      if (failOnce) { failOnce = false; return Promise.reject(new Error('temporary storage failure')) }
      return stored.patch(...args)
    },
  }
  const registered = new Map()
  const host = { logger: { info() {}, warn() {}, error() {} }, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let refreshCount = 0
  globalThis.fetch = async (value, init) => {
    if (new URL(value).origin !== 'https://github.com') return originalFetch(value, init)
    refreshCount++
    return Response.json({ access_token: 'newtoken', token_type: 'bearer', expires_in: 3600, refresh_token: 'newrefreshtoken' })
  }
  try {
    await bridge.start()
    const read = registered.get('mcp__github__get_file_contents')
    Date.now = () => originalNow() + 90000
    const first = await read.execute({ path: 'one' }, {}).catch((error) => ({ failure: error.message }))
    assert.equal(first.failure, undefined)
    assert.match(bridge.snapshot().warning, /save/i)
    assert.equal(refreshCount, 1)
    const second = await read.execute({ path: 'two' }, {})
    assert.match(second.content[0].text, /\[REDACTED\]/)
    assert.equal(refreshCount, 1)
    assert.equal(bridge.snapshot().warning, undefined)
    const reloaded = new SessionStore(file)
    await reloaded.load()
    assert.equal(reloaded.current.token, 'newtoken')
    assert.equal(reloaded.current.oauthRefreshToken, 'newrefreshtoken')
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('waits for an in-flight token rotation before switching and cancelling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-rotation-race-'))
  const mcp = await startMockMcp({ token: ['oldtoken', 'newtoken'] })
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const store = new SessionStore(file)
  await store.patch({ source: 'oauth', token: 'oldtoken', oauthRefreshToken: 'oldrefreshtoken', oauthExpiresAt: Date.now() + 120000, oauthClientId: 'Iv1.testClientId' })
  const registered = new Map()
  const host = { logger: { info() {}, warn() {}, error() {} }, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let releaseRefresh
  let refreshStarted = false
  let refreshCount = 0
  globalThis.fetch = async (value, init) => {
    const url = new URL(value)
    if (url.origin !== 'https://github.com') return originalFetch(value, init)
    if (url.pathname === '/login/device/code') return Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 })
    if (++refreshCount > 1) return Response.json({ error: 'bad_refresh_token' })
    refreshStarted = true
    await new Promise((resolve) => { releaseRefresh = resolve })
    if (init.signal.aborted) throw new Error('refresh request was aborted')
    return Response.json({ access_token: 'newtoken', token_type: 'bearer', expires_in: 3600, refresh_token: 'newrefreshtoken' })
  }
  try {
    await bridge.start()
    const read = registered.get('mcp__github__get_file_contents')
    Date.now = () => originalNow() + 90000
    const pendingRead = read.execute({ path: 'one' }, {}).catch(() => undefined)
    await waitUntil(() => refreshStarted)
    const pendingConnect = bridge.connect({ source: 'oauth' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    releaseRefresh()
    assert.equal((await pendingConnect).status, 'authorizing')
    await pendingRead
    const cancelled = await bridge.cancel()
    assert.equal(cancelled.status, 'ready')
    assert.equal(cancelled.source, 'oauth')
    const reloaded = new SessionStore(file)
    await reloaded.load()
    assert.equal(reloaded.current.token, 'newtoken')
    assert.equal(reloaded.current.oauthRefreshToken, 'newrefreshtoken')
  } finally {
    releaseRefresh?.()
    Date.now = originalNow
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('prompts for additional GitHub scopes and uses them on explicit reauthorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-scope-'))
  const mcp = await startMockMcp({ token: ['oldtoken', 'newtoken', 'thirdtoken'], scopeChallenge: true })
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const store = new SessionStore(file)
  await store.patch({ source: 'oauth', token: 'oldtoken', oauthClientId: 'Iv1.testClientId' })
  const registered = new Map()
  const host = { logger: { info() {}, warn() {}, error() {} }, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  const requestedScopes = []
  let completedAuthorizations = 0
  globalThis.fetch = async (value, init) => {
    const url = new URL(value)
    if (url.origin !== 'https://github.com') return originalFetch(value, init)
    if (url.pathname === '/login/device/code') {
      requestedScopes.push(new URLSearchParams(init.body).get('scope'))
      return Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 })
    }
    completedAuthorizations++
    if (completedAuthorizations === 2) return Response.json({ error: 'access_denied' })
    return Response.json({ access_token: completedAuthorizations === 1 ? 'newtoken' : 'thirdtoken', token_type: 'bearer', scope: completedAuthorizations === 1 ? 'repo,read:org,workflow' : 'repo,read:org,workflow,notifications' })
  }
  try {
    await bridge.start()
    assert.equal(bridge.snapshot().status, 'ready')
    assert.equal(bridge.requiresApproval('mcp__github__push_files'), true)
    await assert.rejects(registered.get('mcp__github__push_files').execute({}, {}), /additional.*workflow/i)
    assert.deepEqual(bridge.snapshot().requiredScopes, ['repo', 'workflow'])
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    assert.deepEqual(new Set(requestedScopes[0].split(' ')), new Set(['repo', 'read:org', 'workflow', 'read:user', 'notifications', 'read:project', 'gist', 'security_events']))
    await waitUntil(() => bridge.snapshot().status === 'ready')
    assert.equal(bridge.snapshot().requiredScopes, undefined)
    const result = await registered.get('mcp__github__push_files').execute({}, {})
    assert.match(result.content[0].text, /\[REDACTED\]/)
    await assert.rejects(registered.get('mcp__github__unknown_tool').execute({}, {}), /additional.*notifications/i)
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    assert.deepEqual(new Set(requestedScopes[1].split(' ')), new Set(['repo', 'read:org', 'workflow', 'read:user', 'notifications', 'read:project', 'gist', 'security_events']))
    await waitUntil(() => bridge.snapshot().status === 'error')
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    assert.deepEqual(new Set(requestedScopes[2].split(' ')), new Set(['repo', 'read:org', 'workflow', 'read:user', 'notifications', 'read:project', 'gist', 'security_events']))
    await waitUntil(() => bridge.snapshot().status === 'ready')
  } finally {
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('recognizes GitHub MCP enterprise authorization scopes', () => {
  assert.deepEqual(parseRequestedScopes('repo read:enterprise admin:enterprise'), ['repo', 'read:enterprise', 'admin:enterprise'])
})

test('requests the workflow scope by default and guides reauthorization after a workflow refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-workflow-'))
  const mcp = await startMockMcp({ workflowRefusal: true })
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const registered = new Map()
  const host = { logger: { info() {}, warn() {}, error() {} }, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', store: new SessionStore(file) }
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  const requestedScopes = []
  globalThis.fetch = async (value, init) => {
    const url = new URL(value)
    if (url.origin !== 'https://github.com') return originalFetch(value, init)
    if (url.pathname === '/login/device/code') {
      requestedScopes.push(new URLSearchParams(init.body).get('scope'))
      return Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 })
    }
    return Response.json({ access_token: 'testtoken', token_type: 'bearer' })
  }
  try {
    await bridge.start()
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    await waitUntil(() => bridge.snapshot().status === 'ready')
    assert.ok(new Set(requestedScopes[0].split(' ')).has('workflow'))
    await assert.rejects(registered.get('mcp__github__push_files').execute({}, {}), /additional permissions \(workflow\).*Connect again/)
    assert.deepEqual(bridge.snapshot().requiredScopes, ['workflow'])
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    assert.deepEqual(new Set(requestedScopes[1].split(' ')), new Set(['repo', 'read:org', 'workflow', 'read:user', 'notifications', 'read:project', 'gist', 'security_events']))
    await waitUntil(() => bridge.snapshot().status === 'ready')
    assert.equal(bridge.snapshot().requiredScopes, undefined)
  } finally {
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('requests configured extra device-flow scopes and exposes granted scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-oauth-extra-'))
  const mcp = await startMockMcp({})
  const file = sessionFileFor('github', mcp.url, join(root, 'cordis.patch.yml'))
  const registered = new Map()
  const host = { logger: { info() {}, warn() {}, error() {} }, register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }
  const config = { serverName: 'github', url: mcp.url, toolCallTimeoutMs: 2000, toolsets: 'repos,issues', readOnly: false, credentialSource: 'saved', oauthClientId: 'Iv1.testClientId', oauthScopes: 'gist, read:packages', store: new SessionStore(file) }
  assert.throws(() => new GithubBridge(host, { ...config, oauthScopes: 'not_a_real_scope' }), /invalid oauthScopes/)
  const bridge = new GithubBridge(host, config)
  const originalFetch = globalThis.fetch
  const requestedScopes = []
  globalThis.fetch = async (value, init) => {
    const url = new URL(value)
    if (url.origin !== 'https://github.com') return originalFetch(value, init)
    if (url.pathname === '/login/device/code') {
      requestedScopes.push(new URLSearchParams(init.body).get('scope'))
      return Response.json({ device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 1 })
    }
    return Response.json({ access_token: 'testtoken', token_type: 'bearer', scope: 'repo,read:org,workflow,read:user,notifications,gist,read:packages' })
  }
  try {
    await bridge.start()
    assert.equal((await bridge.connect({ source: 'oauth' })).status, 'authorizing')
    await waitUntil(() => bridge.snapshot().status === 'ready')
    assert.deepEqual(new Set(requestedScopes[0].split(' ')), new Set(['repo', 'read:org', 'workflow', 'read:user', 'notifications', 'read:project', 'gist', 'security_events', 'read:packages']))
    assert.deepEqual(bridge.snapshot().scopes, ['repo', 'read:org', 'workflow', 'read:user', 'notifications', 'gist', 'read:packages'])
  } finally {
    globalThis.fetch = originalFetch
    await bridge.dispose()
    await mcp.close()
    await rm(root, { recursive: true, force: true })
  }
})

