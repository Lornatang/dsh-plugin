import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const snapshot = (status, extra) => Response.json({ ok: true, status, toolCount: 0, readOnly: false, oauthAvailable: true, ...extra })

function settings() {
  // Drive the built component with a minimal hook host and deferred HTTP.
  // Deliberately allow an aborted fetch to settle, as a completed body might.
  const hooks = []
  const requests = []
  const timers = new Set()
  const deadlines = new Set()
  let cursor
  let mountEffect
  let cleanup
  let visibilityChange
  let GithubSettings
  const react = {
    createElement: (_type, props, ...children) => ({ props, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = initial
      return [hooks[index], (value) => { hooks[index] = value }]
    },
    useRef(initial) { return hooks[cursor++] ??= { current: initial } },
    useCallback(callback) { return callback },
    useEffect(effect) { mountEffect = effect },
  }
  const document = {
    hidden: false, querySelector: () => true,
    addEventListener: (_name, listener) => { visibilityChange = listener },
    removeEventListener: () => { visibilityChange = undefined },
  }
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { ({ GithubSettings } = factory(() => react)) } },
    open() {},
    setInterval(fn) { timers.add(fn); return fn },
    clearInterval(fn) { timers.delete(fn) },
    setTimeout(fn) { deadlines.add(fn); return fn },
    clearTimeout(fn) { deadlines.delete(fn) },
  }
  runInNewContext(bundle, { document, window, AbortController, fetch(path, options) {
    const { promise, resolve, reject } = Promise.withResolvers()
    requests.push({ path, signal: options.signal, resolve, reject })
    return promise
  } })
  const render = () => { cursor = 0; return GithubSettings() }
  function* nodes(node) {
    yield node
    for (const child of node?.children ?? []) yield* nodes(child)
  }
  render()
  cleanup = mountEffect()
  return {
    requests,
    tick: () => { for (const poll of timers) poll() },
    expireRequests() {
      for (const expire of [...deadlines]) {
        deadlines.delete(expire)
        expire()
      }
    },
    click: (label) => [...nodes(render())].find((node) => node?.children?.includes(label)).props.onClick(),
    text: () => [...nodes(render())].filter((node) => typeof node === 'string').join(' '),
    hide(hidden) { document.hidden = hidden; visibilityChange?.() },
    unmount: () => cleanup(),
  }
}

test('starting OAuth discards earlier status and suppresses polling until the action returns', async () => {
  const ui = settings()
  ui.requests[0].resolve(snapshot('idle'))
  await setImmediate()
  ui.tick()
  const beforeConnect = ui.requests[1]
  ui.click('Connect with GitHub')
  const connect = ui.requests[2]
  assert.equal(connect.path, '/plugins/github/connect')
  ui.tick()
  ui.click('Refresh status')
  assert.equal(ui.requests.length, 3)
  assert.equal(beforeConnect.signal?.aborted, true)
  connect.resolve(snapshot('authorizing', { authorization: { userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device' } }))
  await setImmediate()
  beforeConnect.resolve(snapshot('idle'))
  await setImmediate()
  assert.match(ui.text(), /ABCD-EFGH/)
  ui.tick()
  assert.equal(ui.requests.length, 4)
  ui.unmount()
})

test('old status cannot clear an action error and leaving the panel cancels polling', async () => {
  const ui = settings()
  const beforeConnect = ui.requests[0]
  ui.click('Connect with GitHub CLI')
  ui.requests[1].resolve(Response.json({ ok: false, error: 'GitHub CLI is unavailable' }, { status: 500 }))
  await setImmediate()
  beforeConnect.resolve(snapshot('idle'))
  await setImmediate()
  assert.match(ui.text(), /GitHub CLI is unavailable/)
  ui.tick()
  const beforeHide = ui.requests[2]
  ui.hide(true)
  ui.tick()
  assert.equal(ui.requests.length, 3)
  assert.equal(beforeHide.signal?.aborted, true)
  beforeHide.reject(new Error('Hidden status failed'))
  await setImmediate()
  assert.doesNotMatch(ui.text(), /Hidden status failed/)
  ui.hide(false)
  const beforeUnmount = ui.requests[3]
  ui.unmount()
  assert.equal(beforeUnmount.signal?.aborted, true)
  ui.tick()
  assert.equal(ui.requests.length, 4)
})

test('manual refresh replaces an older pending status request', async () => {
  const ui = settings()
  const older = ui.requests[0]
  ui.click('Refresh status')
  assert.equal(older.signal?.aborted, true)
  ui.requests[1].resolve(snapshot('ready'))
  older.reject(new Error('Old request failed'))
  await setImmediate()
  assert.match(ui.text(), /Connected/)
  assert.doesNotMatch(ui.text(), /Old request failed/)
  ui.unmount()
})

test('automatic polling retries after a stalled status request expires', async () => {
  const ui = settings()
  const stalled = ui.requests[0]
  ui.tick()
  assert.equal(ui.requests.length, 1)
  ui.expireRequests()
  assert.equal(stalled.signal.aborted, true)
  assert.match(ui.text(), /GitHub status request timed out/)
  ui.tick()
  ui.requests[1].resolve(snapshot('ready'))
  await setImmediate()
  stalled.resolve(snapshot('idle'))
  await setImmediate()
  ui.expireRequests()
  assert.match(ui.text(), /Connected/)
  assert.doesNotMatch(ui.text(), /timed out/)
  ui.unmount()
})
