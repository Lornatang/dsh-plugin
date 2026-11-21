import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateOutput } from '../lib/output-validator.js'

const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }

test('validation honors cancellation and keeps the pool usable', async () => {
  const controller = new AbortController()
  const cancelled = validateOutput(schema, { label: 'sample' }, 5000, controller.signal)
  controller.abort()
  await assert.rejects(cancelled, /timed out or was cancelled/)

  const signal = new AbortController().signal
  await Promise.all(Array.from({ length: 8 }, () => validateOutput(schema, { label: 'sample' }, 5000, signal)))
})
