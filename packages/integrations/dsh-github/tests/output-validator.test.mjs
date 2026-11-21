import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateOutput } from '../lib/output-validator.js'

const schema = { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'number' } }, required: ['ok'] }

test('validates structured output and reuses pooled workers across many calls', async () => {
  // Cross the worker recycle boundary (64 tasks) and keep validating afterwards.
  for (let i = 0; i < 70; i++) await validateOutput(schema, { ok: true, count: i }, 2000)
  await assert.rejects(validateOutput(schema, { ok: 'invalid' }, 2000), /structured output does not match its schema/)
  // Invalid data must not retire a healthy worker.
  await validateOutput(schema, { ok: false }, 2000)
})

test('concurrent validations share the bounded pool', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => validateOutput(schema, { ok: true, count: i }, 5000)))
})

test('a pathological schema cannot hang validation or exhaust the pool', async () => {
  const evil = { type: 'string', pattern: '^(a+)+$' }
  const started = Date.now()
  await assert.rejects(validateOutput(evil, 'a'.repeat(30) + 'b', 300), /timed out or was cancelled/)
  assert.ok(Date.now() - started < 6000, 'validation must settle near its timeout instead of hanging on worker cleanup')
  // Slots and workers must be usable again after the stuck validator is abandoned.
  await validateOutput(schema, { ok: true }, 2000)
  await validateOutput(schema, { ok: true }, 2000)
})

test('stuck-worker retirement never holds a validation slot', async () => {
  const evil = { type: 'string', pattern: '^(a+)+$' }
  const started = Date.now()
  // Fill every slot with a validator that ignores terminate(), then queue one
  // healthy validation behind them. It must start when the timeouts fire, not
  // after each stuck worker's retirement grace period.
  const stuck = Array.from({ length: 4 }, () =>
    assert.rejects(validateOutput(evil, 'a'.repeat(40) + '!', 250), /timed out or was cancelled/))
  const queued = validateOutput(schema, { ok: true }, 4000)
  await Promise.all([...stuck, queued])
  const elapsed = Date.now() - started
  assert.ok(elapsed < 900, `queued validation waited ${elapsed}ms; retirement must not hold slots`)
})

test('abort signals and asynchronous schemas are rejected', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(validateOutput(schema, { ok: true }, 2000, controller.signal), /timed out or was cancelled/)
  await assert.rejects(validateOutput({ $async: true, type: 'object' }, {}, 2000), /structured output does not match its schema/)
})
