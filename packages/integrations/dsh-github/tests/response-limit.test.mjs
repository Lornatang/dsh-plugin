import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitResponse } from '../lib/response-limit.js'

const encoder = new TextEncoder()
function streamResponse(chunks, contentType = 'text/event-stream', status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': contentType } })
}
async function drain(response) {
  const reader = response.body.getReader()
  const parts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}

test('passes SSE bytes through and counts events across split CRLF separators', async () => {
  let events = 0
  const text = 'data: a\r\n\r\ndata: b\n\n'
  const response = await limitResponse(streamResponse(['data: a\r', '\n\r', '\ndata: b\n', '\n']), 1024, () => assert.fail('limit'), () => { events++ })
  assert.equal(await drain(response), text)
  assert.equal(events, 2)
})

test('CR-only separators and comment lines follow SSE event accounting', async () => {
  let events = 0
  let limits = 0
  const response = await limitResponse(streamResponse(['data: a\r', '\rdata: b\r\r']), 1024, () => { limits++ }, () => { events++ })
  assert.equal(await drain(response), 'data: a\r\rdata: b\r\r')
  assert.equal(events, 2)
  assert.equal(limits, 0)
  // Comment lines rewind the per-event budget, so keepalives never trip it.
  let commentEvents = 0
  const comments = await limitResponse(streamResponse([': keepalive\n', ': keepalive\n', '\n', 'data: ok\n\n']), 16, () => assert.fail('limit'), () => { commentEvents++ })
  assert.equal(await drain(comments), ': keepalive\n: keepalive\n\ndata: ok\n\n')
  assert.equal(commentEvents, 2)
})

test('limits a single oversized event and separator-free bulk chunks alike', async () => {
  let limits = 0
  const response = await limitResponse(streamResponse(['data: ', 'x'.repeat(50), '\n\n']), 10, () => { limits++ })
  await assert.rejects(drain(response), /byte limit/)
  assert.equal(limits, 1)
  // The bulk fast path (chunks without CR/LF) must enforce the same budget.
  let bulkLimits = 0
  const bulk = await limitResponse(streamResponse(['data: ', ...Array.from({ length: 10 }, () => 'y'.repeat(100)), '\n\n']), 500, () => { bulkLimits++ })
  await assert.rejects(drain(bulk), /byte limit/)
  assert.equal(bulkLimits, 1)
  let events = 0
  const ok = await limitResponse(streamResponse(['data: ', ...Array.from({ length: 10 }, () => 'y'.repeat(100)), '\n\n']), 2000, () => assert.fail('limit'), () => { events++ })
  assert.equal((await drain(ok)).length, 1008)
  assert.equal(events, 1)
})

test('whole-body consumers enforce a total limit on SSE responses', async () => {
  let limits = 0
  const chunks = ['data: aaaaaaaaaa\n\n', 'data: bbbbbbbbbb\n\n']
  const perEvent = await limitResponse(streamResponse(chunks), 20, () => { limits++ })
  assert.equal((await drain(perEvent)).length, 36)
  assert.equal(limits, 0)
  const whole = await limitResponse(streamResponse(chunks), 20, () => { limits++ })
  await assert.rejects(whole.text(), /byte limit/)
  assert.equal(limits, 1)
})

test('non-SSE and error responses enforce the total limit', async () => {
  let limits = 0
  const json = await limitResponse(streamResponse(['x'.repeat(30)], 'application/json'), 20, () => { limits++ })
  await assert.rejects(json.arrayBuffer(), /byte limit/)
  assert.equal(limits, 1)
  const smallError = await limitResponse(streamResponse(['oops'], 'text/plain', 403), 20, () => assert.fail('limit'))
  assert.equal(await smallError.text(), 'oops')
  let errorLimits = 0
  // Error bodies are buffered inside limitResponse, so the limit rejects there.
  await assert.rejects(limitResponse(streamResponse(['x'.repeat(30)], 'text/plain', 403), 20, () => { errorLimits++ }), /byte limit/)
  assert.equal(errorLimits, 1)
})

// Keep the byte-at-a-time reference independent of the production span scanner.
function referenceLimit(chunks, maxBytes) {
  let size = 0
  let lineSize = 0
  let lineStartSize = 0
  let comment = false
  let previousCR = false
  let discardFollowingLF = false
  let events = 0
  let limited = false
  const out = []
  const fail = () => { limited = true; throw new Error('limit') }
  try {
    for (const chunk of chunks) {
      for (let index = 0; index < chunk.length; index++) {
        const byte = chunk[index]
        if (byte === 10 && previousCR) {
          previousCR = false
          if (!discardFollowingLF && ++size > maxBytes) fail()
          lineStartSize = size
          continue
        }
        if (++size > maxBytes) fail()
        if (byte === 13) {
          discardFollowingLF = lineSize === 0 || comment
          if (lineSize === 0) { events++; size = 0 }
          else if (comment) { size = lineStartSize }
          lineSize = 0
          comment = false
          lineStartSize = size
          previousCR = true
        } else if (byte === 10) {
          if (lineSize === 0) { events++; size = 0 }
          else if (comment) { size = lineStartSize }
          lineSize = 0
          comment = false
          lineStartSize = size
          previousCR = false
        } else {
          if (lineSize === 0) comment = byte === 58
          lineSize++
          previousCR = false
        }
      }
      out.push(chunk)
    }
  } catch { /* limited */ }
  return { limited, events, out: Buffer.concat(out) }
}


async function actualLimit(chunks, maxBytes) {
  let events = 0
  let limits = 0
  const response = await limitResponse(streamResponse(chunks), maxBytes, () => { limits++ }, () => { events++ })
  const reader = response.body.getReader()
  const out = []
  let limited = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.push(Buffer.from(value))
    }
  } catch { limited = true }
  return { limited, events, limits, out: Buffer.concat(out) }
}

test('counts decoded bytes at exact SSE boundaries, including split CRLF', async () => {
  const cases = [
    { chunks: ['data: ok\n', '\n'], exact: 10 },
    { chunks: ['data: ok\r', '', '\n\r', '\n'], exact: 11 },
    { chunks: ['data: ok\r', '\r'], exact: 10 },
    { chunks: ['data: 字😀\r', '\n\r', '\n'], exact: 16 },
    { chunks: ['data: a\r\n', ': b\r', '\n\r', '\n'], exact: 13 },
  ]
  for (const { chunks, exact } of cases) {
    const bytes = chunks.map((chunk) => encoder.encode(chunk))
    const accepted = await actualLimit(bytes, exact)
    assert.equal(accepted.limited, false, JSON.stringify(chunks))
    assert.equal(accepted.events, 1)
    assert.deepEqual(accepted.out, Buffer.concat(bytes))
    const rejected = await actualLimit(bytes, exact - 1)
    assert.equal(rejected.limited, true, JSON.stringify(chunks))
    assert.equal(rejected.limits, 1)
    assert.equal(rejected.events, 0)
  }
})

test('SSE limiting matches the byte-by-byte reference on random streams', async () => {
  let seed = 42
  const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296 }
  const pick = (items) => items[Math.floor(rand() * items.length)]
  const tokens = ['data: hello', 'data: {"a":1}', ': keepalive', ':', 'event: x', 'id: 7', 'retry: 100', 'a', '字😀', '\r', '\n', '\r\n', ' ', 'x'.repeat(50), 'data: ' + 'y'.repeat(120)]
  const budgets = [8, 16, 32, 128, 1024, 100000]
  for (let iteration = 0; iteration < 400; iteration++) {
    let text = ''
    const count = 1 + Math.floor(rand() * 150)
    for (let index = 0; index < count; index++) text += pick(tokens)
    const bytes = encoder.encode(text)
    const chunks = []
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(bytes.length - offset, 1 + Math.floor(rand() * 64))
      chunks.push(bytes.subarray(offset, offset + length))
      offset += length
    }
    const maxBytes = pick(budgets)
    const expected = referenceLimit(chunks, maxBytes)
    const actual = await actualLimit(chunks, maxBytes)
    const context = `iteration ${iteration} maxBytes ${maxBytes} input ${Buffer.from(bytes).toString('hex').slice(0, 200)}`
    assert.equal(actual.limited, expected.limited, `limited: ${context}`)
    assert.equal(actual.events, expected.events, `events: ${context}`)
    assert.equal(actual.limits, expected.limited ? 1 : 0, `limits: ${context}`)
    assert.ok(actual.out.equals(expected.out), `output: ${context}`)
  }
})
