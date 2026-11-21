import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const modeModule = await import('../lib/mode.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/lib/mode.js')) return undefined
  throw error
})
const user = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const injected = text => ({ source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] })
const event = message => ({ type: 'user/message', data: message })

test('mode follows real user commands and is independent for each session', () => {
  assert.ok(modeModule, 'mode adapter is implemented')
  const { resolveMode } = modeModule
  const a = [event(user('/ultracave'))]
  const b = [event(user('/megacave'))]
  assert.equal(resolveMode('caveman', a, [user('continue')]).mode, 'ultracave')
  assert.equal(resolveMode('caveman', b, [user('continue')]).mode, 'megacave')
  assert.equal(resolveMode('caveman', a, [user('stop caveman')]).mode, 'off')
  assert.equal(resolveMode('caveman', b, [user('continue')]).mode, 'megacave')
})

test('status and independent one-shot commands do not change the persisted mode', () => {
  assert.ok(modeModule, 'mode adapter is implemented')
  const { resolveMode } = modeModule
  const history = [event(user('/ultracave'))]
  assert.deepEqual(resolveMode('caveman', history, [user('/caveman status')]), { mode: 'ultracave', action: 'status' })
  assert.deepEqual(resolveMode('caveman', history, [user('/caveman-review')]), { mode: 'ultracave', action: 'one-shot' })
  assert.equal(resolveMode('caveman', [...history, event(user('/caveman-review'))], [user('next task')]).mode, 'ultracave')
})

test('quoted text and injected instructions do not control the mode', () => {
  assert.ok(modeModule, 'mode adapter is implemented')
  const { resolveMode } = modeModule
  assert.equal(resolveMode('manual', [event(injected('/ultracave'))], [user('The docs quote "turn on caveman".')]).mode, 'off')
  assert.equal(resolveMode('manual', [], [user('activate caveman')]).mode, 'caveman')
})

test('session mode replay only reads new events and resets when its inputs change', () => {
  const { SessionModeTracker } = modeModule
  const events = [event(user('/ultracave')), event(injected('/megacave'))]
  const reads = []
  const session = {
    get seq() { return events.length },
    snapshotEvents(from = 0) { reads.push(from); return events.slice(from) },
  }
  const tracker = new SessionModeTracker()
  assert.equal(tracker.resolve('manual', session, [user('continue')]).mode, 'ultracave')
  events.push(event(user('/megacave')))
  assert.equal(tracker.resolve('manual', session, [user('continue')]).mode, 'megacave')
  assert.equal(tracker.resolve('manual', session, [user('stop caveman')]).mode, 'off')
  assert.equal(tracker.resolve('manual', session, [user('continue')]).mode, 'megacave', 'uncommitted input does not persist')
  assert.deepEqual(reads, [0, 2, 3, 3])
  assert.equal(tracker.resolve('off', session, [user('continue')]).mode, 'megacave')
  assert.equal(reads.at(-1), 0, 'a different default replays history')
  events.length = 1
  assert.equal(tracker.resolve('off', session, [user('continue')]).mode, 'ultracave')
  assert.equal(reads.at(-1), 0, 'a shorter log replays history')
  const other = { seq: 0, snapshotEvents: () => [] }
  assert.equal(tracker.resolve('manual', other, [user('continue')]).mode, 'off', 'sessions remain isolated')
})

test('the environment and project default are used when the profile has no override', async () => {
  assert.ok(modeModule, 'mode adapter is implemented')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-config-'))
  const previous = process.env.CAVEMAN_DEFAULT_MODE
  try {
    delete process.env.CAVEMAN_DEFAULT_MODE
    await writeFile(join(directory, '.caveman.json'), '{"defaultMode":"megacave"}')
    assert.equal(modeModule.defaultModeFor(undefined, directory), 'megacave')
    process.env.CAVEMAN_DEFAULT_MODE = 'ultracave'
    assert.equal(modeModule.defaultModeFor(undefined, directory), 'ultracave')
    assert.equal(modeModule.defaultModeFor('manual', directory), 'manual')
  } finally {
    if (previous === undefined) delete process.env.CAVEMAN_DEFAULT_MODE
    else process.env.CAVEMAN_DEFAULT_MODE = previous
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-config-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  }
})
