import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { test } from 'node:test'
import { registerRoutes, ROUTE_PREFIX, REQUEST_BODY_TIMEOUT_MS } from '../lib/routes.js'

const snapshot = { status: 'idle', toolCount: 0, readOnly: false, oauthAvailable: false }
const bridge = { snapshot: () => snapshot, connect: async () => snapshot, cancel: async () => snapshot, disconnect: async () => snapshot }
const fence = { requestRejection: () => undefined }

async function withServer(fn) {
  const server = createServer()
  const unregister = registerRoutes({ register(route) { server.on('request', route.handler); return () => server.removeAllListeners('request') } }, bridge, fence)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await fn(`http://127.0.0.1:${server.address().port}`) }
  finally { unregister(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
}

test('serves status and accepts a valid fenced connect body', async () => {
  await withServer(async (base) => {
    const status = await fetch(`${base}${ROUTE_PREFIX}/status`)
    assert.equal(status.status, 200)
    assert.equal((await status.json()).ok, true)
    const connected = await fetch(`${base}${ROUTE_PREFIX}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'gh' }) })
    assert.equal(connected.status, 200)
    assert.equal((await connected.json()).ok, true)
  })
})

test('rejects oversized and malformed connect bodies', async () => {
  await withServer(async (base) => {
    const oversized = await fetch(`${base}${ROUTE_PREFIX}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'token', token: 'x'.repeat(9000) }) })
    assert.equal(oversized.status, 400)
    const malformed = await fetch(`${base}${ROUTE_PREFIX}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'gh', extra: true }) })
    assert.equal(malformed.status, 400)
  })
})

test('cuts off a slow request body at the deadline', async () => {
  await withServer(async (base) => {
    const socket = connect(Number(new URL(base).port), '127.0.0.1')
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const started = Date.now()
    socket.write(`POST ${ROUTE_PREFIX}/connect HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"source":`)
    const elapsed = await new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('socket still open past the body deadline')), REQUEST_BODY_TIMEOUT_MS + 3000)
      const settled = () => { clearTimeout(guard); resolve(Date.now() - started) }
      socket.once('close', settled)
      socket.once('error', settled)
    })
    assert.ok(elapsed >= REQUEST_BODY_TIMEOUT_MS - 500, `connection closed too early: ${elapsed}ms`)
    assert.ok(elapsed < REQUEST_BODY_TIMEOUT_MS + 2500, `connection closed too late: ${elapsed}ms`)
    socket.destroy()
  })
})
