import assert from 'node:assert/strict'
import test from 'node:test'
import { CompressionHistoryIndex, planCompressionBatches, projectionCoverage, registerCompression, resolveOriginalResult } from '../lib/compression.js'

test('compressed blocks must appear on their own tool result before dispatch', () => {
  const expected = [
    { callId: 'one', blocks: [{ index: 0, text: 'shortened one' }, { index: 2, text: 'shortened two' }] },
    { callId: 'two', blocks: [{ index: 0, text: 'shortened one' }] },
  ]
  const one = { role: 'tool', toolCallId: 'one', content: [
    { type: 'text', text: 'shortened one' }, { type: 'text', text: 'unchanged' }, { type: 'text', text: 'shortened two' },
  ] }
  const two = { role: 'tool', toolCallId: 'two', content: [{ type: 'text', text: 'shortened one' }] }
  assert.equal(projectionCoverage(expected, []), 'none')
  assert.equal(projectionCoverage(expected, [one]), 'incomplete')
  assert.equal(projectionCoverage(expected, [two, { ...one, content: [two.content[0]] }]), 'incomplete')
  assert.equal(projectionCoverage(expected, [one, two]), 'complete')
})

test('batch planning respects size, segment count, and duplicate identities', () => {
  const item = (name, bytes, ids) => ({ name, bytes, segments: ids.map(id => ({ id })) })
  const candidates = [
    item('a', 4, ['1']), item('b', 5, ['2']), item('c', 4, ['1']),
    item('d', 20, ['3']), item('e', 4, ['4', '5']), item('f', 4, ['6']),
  ]
  const batches = planCompressionBatches(candidates, 10, 2)
  assert.deepEqual(batches.map(batch => batch.map(value => value.name)), [['a', 'b'], ['c'], ['d'], ['e'], ['f']])
  assert.deepEqual(batches.flat(), candidates)
})

test('original tool events are resolved once per session', () => {
  const first = { type: 'tool/result', seq: 1 }
  const second = { type: 'tool/result', seq: 2, sourceEventSeqs: [1] }
  const third = { type: 'tool/result', seq: 3, sourceEventSeqs: [2] }
  let reads = 0
  const events = new Map([[1, first], [2, second], [3, third]])
  const session = { eventAt(seq) { reads++; return events.get(seq) } }
  assert.equal(resolveOriginalResult(session, third), first)
  const initialReads = reads
  assert.equal(resolveOriginalResult(session, third), first)
  assert.equal(reads, initialReads, 'repeated resolution avoids walking the same history')
  const otherFirst = { type: 'tool/result', seq: 1 }
  const otherSession = { eventAt(seq) { return seq === 1 ? otherFirst : events.get(seq) } }
  assert.equal(resolveOriginalResult(otherSession, third), otherFirst, 'cached results remain session scoped')
})

test('compression history reads only new events and keeps recovery scoped to each session', () => {
  const handle = `cmw_${'a'.repeat(48)}`
  const original = { seq: 1, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'original' }] } } }
  const events = [
    { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'first', name: 'read' }] } } },
    original,
    { seq: 2, type: 'tool/result', sourceEventSeqs: [1], data: { message: { content: [{ type: 'text', text: `[caveman: shortened; exact original via caveman_retrieve handle=${handle}` }] } } },
  ]
  const reads = []
  const session = { get seq() { return events.length }, snapshotEvents(from = 0, to = events.length) { reads.push(from); return events.slice(from, to) }, eventAt: seq => events.find(event => event.seq === seq) }
  const index = new CompressionHistoryIndex()
  let current = index.read(session)
  assert.equal(current.toolNames.get('first'), 'read')
  assert.equal(current.hasMarker, true)
  assert.deepEqual(current.originals.get(handle), { text: 'original', sourceId: 'seq-1' })
  events.push({ seq: 3, type: 'tool/ptc-dispatch', data: { rootCallId: 'program', name: 'caveman_retrieve' } })
  current = index.read(session)
  assert.equal(current.managedCalls.has('program'), true)
  assert.deepEqual(reads, [0, 3])
  const other = { seq: 0, snapshotEvents: () => [], eventAt: () => undefined }
  assert.equal(index.read(other).hasMarker, false)
  events.splice(0, events.length)
  assert.equal(index.read(session).hasMarker, false, 'truncated logs invalidate prior state')
})

test('offline recovery preserves BOMs and paginates at UTF-8 byte boundaries', async () => {
  const handle = `cmw_${'a'.repeat(48)}`
  const original = '\ufeffx\ufeffé🙂'
  const message = text => ({ message: { content: [{ type: 'text', text }] } })
  const events = [
    { seq: 0, type: 'tool/result', data: message(original) },
    { seq: 1, type: 'tool/result', sourceEventSeqs: [0],
      data: message(`[caveman: shortened; exact original via caveman_retrieve handle=${handle}`) },
  ]
  const session = { id: 'offline', seq: events.length, snapshotEvents: () => events, eventAt: seq => events[seq] }
  const exec = { agent: { session }, signal: new AbortController().signal }
  let tool
  let cleanup
  registerCompression({
    tools: { get: () => undefined, register: definition => { tool = definition } },
    effect: callback => { cleanup = callback() },
    on() {},
  }, 'http://127.0.0.1:1', {
    fetch: async () => { throw new Error('Fixture runtime offline') },
    available: async () => false,
  })
  const recover = async args => JSON.parse(await tool.execute({ handle, ...args }, exec))
  try {
    const first = await recover({ limit: 6 })
    assert.equal(first.text, '\ufeffx')
    assert.equal(first.next_offset, 4)
    assert.equal(first.total_bytes, 13)
    assert.equal(first.complete, false)
    const second = await recover({ offset: first.next_offset, limit: 5 })
    assert.equal(second.text, '\ufeffé')
    assert.equal(second.next_offset, 9)
    const third = await recover({ offset: second.next_offset, limit: 4 })
    assert.equal(first.text + second.text + third.text, original)
    assert.equal(third.next_offset, null)
    assert.equal(third.complete, false)
    const complete = await recover({})
    assert.equal(complete.text, original)
    assert.equal(complete.complete, true)
    assert.equal(complete.next_offset, null)
    await assert.rejects(recover({ offset: 12, limit: 4 }), /UTF-8 boundary/u)
    assert.equal((await recover({ offset: 13, limit: 4 })).text, '')
  } finally { await cleanup() }
})
