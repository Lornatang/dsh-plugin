import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { findCavemanBinary, guardedRuntimeFetch, moduleEnabled, runtimeSettings } from '../lib/runtime.js'

test('runtime discovery honors overrides, PATH, the Caveman home, and module switches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-caveman-discovery-'))
  const home = join(root, 'home')
  const bin = join(home, 'bin')
  const pathBin = join(root, 'path')
  const filename = process.platform === 'win32' ? 'caveman-browse.exe' : 'caveman-browse'
  const local = join(bin, filename)
  const onPath = join(pathBin, filename)
  const override = join(root, filename)
  try {
    await mkdir(bin, { recursive: true })
    await mkdir(pathBin)
    await writeFile(join(home, 'cloud.json'), '{}')
    for (const file of [local, onPath, override]) {
      await writeFile(file, 'fixture')
      await chmod(file, 0o755)
    }
    const env = { CAVEMAN_HOME: home, PATH: [pathBin, join(root, 'missing')].join(delimiter) }
    assert.equal(findCavemanBinary('browse', undefined, env), onPath)
    assert.equal(findCavemanBinary('browse', undefined, { ...env, PATH: '' }), local)
    assert.equal(findCavemanBinary('browse', undefined, { ...env, CAVEMAN_BROWSE_BIN: override }), override)
    assert.equal(findCavemanBinary('browse', local, { ...env, CAVEMAN_BROWSE_BIN: override }), local)
    assert.equal(findCavemanBinary('browse', undefined, { ...env, CAVEMAN_BROWSE_BIN: join(root, 'missing') }), undefined)
    assert.throws(() => findCavemanBinary('browse', 'relative-binary', env), /absolute path/u)
    assert.equal(moduleEnabled('browse', env), true)
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ modules: { browse: false, scripts: true } }))
    assert.equal(moduleEnabled('browse', env), false)
    assert.equal(moduleEnabled('scripts', env), true)
    await writeFile(join(home, 'cloud.json'), '\uFEFF' + JSON.stringify({ execute: { browse_tool: false } }))
    assert.equal(moduleEnabled('browse', env), false)
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ modules: { browse: true }, execute: { browse_tool: false } }))
    assert.equal(moduleEnabled('browse', env), true)
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ think: { mode: 'record' } }))
    assert.equal(moduleEnabled('input', env), false)
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ modules: { input: true }, think: { mode: 'record' } }))
    assert.equal(moduleEnabled('input', env), true)
    assert.equal(runtimeSettings(env).core, false, 'record mode disables the native coding policy')
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ modules: { output: false } }))
    assert.equal(runtimeSettings(env).core, false)
    assert.equal(runtimeSettings({ ...env, CAVEMAN_CORE: 'on' }).core, true)
    assert.equal(runtimeSettings({ ...env, CAVEMAN_NATIVE_MODE: 'record', CAVEMAN_CORE: 'on' }).core, false)
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ modules: { output: true }, think: { core: false } }))
    assert.equal(runtimeSettings(env).core, false, 'the effective core setting wins when stored values disagree')
    await writeFile(join(home, 'cloud.json'), '{}')
    assert.equal(runtimeSettings(env).core, true)
    assert.equal(runtimeSettings(env).mcp, true)
    assert.equal(runtimeSettings(env).memory, true)
    assert.equal(runtimeSettings({ ...env, CAVEMAN_MCP: 'off' }).mcp, false)
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ execute: { mcp: 'marker-only' } }))
    assert.equal(runtimeSettings(env).mcp, false)
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ remember: { mem: false } }))
    assert.equal(runtimeSettings(env).memory, false)
    await writeFile(join(home, 'cloud.json'), '{invalid')
    assert.equal(moduleEnabled('browse', env), true)
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('dsh-caveman-discovery-')) throw new Error('unexpected test directory')
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('automatic middleware refuses a foreign listener before sending content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-caveman-discovery-'))
  const run = join(root, 'run')
  let observed = 0
  let listenerToken = 'foreign'
  const server = createServer((request, response) => {
    if (request.url === '/health/live') {
      response.writeHead(200, { 'x-caveman-instance': listenerToken })
      response.end('ok')
    } else {
      observed++
      response.end('accepted')
    }
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject))
  const port = server.address().port
  const endpoint = `http://127.0.0.1:${port}`
  try {
    await mkdir(run)
    const guarded = guardedRuntimeFetch(endpoint, { CAVEMAN_HOME: root })
    await assert.rejects(guarded(`${endpoint}/optimize`, { method: 'POST', body: 'private' }))
    await writeFile(join(run, `${port}.json`), JSON.stringify({
      schema: 'caveman.proxy.run.v1', owner: 'start', pid: process.pid, port, instance_token: 'expected',
    }))
    await assert.rejects(guarded(`${endpoint}/optimize`, { method: 'POST', body: 'private' }))
    assert.equal(observed, 0, 'neither unverified listener receives content')
    listenerToken = 'expected'
    const response = await guarded(`${endpoint}/optimize`, { method: 'POST', body: 'private' })
    assert.equal(await response.text(), 'accepted')
    assert.equal(observed, 1)
    listenerToken = 'replacement'
    await assert.rejects(guarded(`${endpoint}/optimize`, { method: 'POST', body: 'private' }))
    assert.equal(observed, 1, 'a replaced listener receives no later content')
    await assert.rejects(guarded('http://example.invalid/optimize', { method: 'POST', body: 'private' }))
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('dsh-caveman-discovery-')) throw new Error('unexpected test directory')
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
