import assert from 'node:assert/strict'
import test from 'node:test'
import { cavemanRequestHeaders } from '../lib/attribution.js'

test('proxy attribution is stable, session-scoped, and never sent to another origin', () => {
  const endpoint = 'http://127.0.0.1:8787'
  const request = { baseURL: `${endpoint}/v1`, sessionId: 'session-one' }
  const first = cavemanRequestHeaders(endpoint, request, new Headers())
  const same = cavemanRequestHeaders(endpoint, request, new Headers())
  const other = cavemanRequestHeaders(endpoint, { ...request, sessionId: 'session-two' }, new Headers())
  assert.match(first.get('x-cave-session'), /^dsh-[a-f0-9]{32}$/u)
  assert.equal(first.get('x-cave-session'), same.get('x-cave-session'))
  assert.notEqual(first.get('x-cave-session'), other.get('x-cave-session'))
  assert.equal(first.get('x-cave-agent'), 'dsh')
  const preserved = cavemanRequestHeaders(endpoint, request, new Headers({ 'x-cave-session': 'custom', 'x-cave-agent': 'other' }))
  assert.equal(preserved.get('x-cave-session'), 'custom')
  assert.equal(preserved.get('x-cave-agent'), 'other')
  const external = cavemanRequestHeaders(endpoint, { ...request, baseURL: 'https://example.com/v1' }, new Headers())
  assert.equal(external.has('x-cave-session'), false)
  assert.equal(cavemanRequestHeaders('https://example.com', { ...request, baseURL: 'https://example.com' }, new Headers()).has('x-cave-session'), false)
  assert.equal(cavemanRequestHeaders(endpoint, { baseURL: request.baseURL }, new Headers()).has('x-cave-session'), false)
})
