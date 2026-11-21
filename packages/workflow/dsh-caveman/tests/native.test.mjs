import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { nativeCall, nativePrompt, nativeSocketPath, recoveryIsPublished, registerNative } from '../lib/native.js'

const unixOnly = { skip: process.platform === 'win32' }

test('native task classification sends a digest and bounded terms, not the raw prompt', () => {
  const prompt = 'Fix the regression in login with sk-secret-token and abcdefghijklmnopqrstuvwxyzabcdefghijklmn.'
  const result = nativePrompt(prompt)
  assert.equal(result.task_profile.type, 'bugfix')
  assert.equal(result.prompt.bytes, Buffer.byteLength(prompt))
  assert.match(result.prompt.sha256, /^sha256:[a-f0-9]{64}$/u)
  assert.ok(result.task_profile.terms.includes('login'))
  assert.ok(!result.task_profile.terms.includes('sk-secret-token'))
  assert.ok(!JSON.stringify(result).includes(prompt))
  assert.equal(nativePrompt('please continue').task_profile.continuation, true)
})

test('native socket endpoints are only available for Unix sockets', () => {
  assert.equal(nativeSocketPath('fixture', 'win32'), undefined)
  assert.equal(nativeSocketPath('fixture', 'linux'), join('fixture', 'run', 'native.sock'))
})

test('Windows keeps native events local without installing runtime hooks', { skip: process.platform !== 'win32' }, async () => {
  const request = { toJSON() { assert.fail('Windows must not serialize native events') } }
  assert.equal(await nativeCall('fixture', request), undefined)
  const ctx = { on() { assert.fail('Windows must not register native hooks') } }
  registerNative(ctx, 'http://127.0.0.1:8787', { mode: 'safe', profile: 'full-safe', core: true })
})

test('native recovery hints require a published direct tool or program binding', () => {
  const tool = { name: 'mcp__caveman__caveman_retrieve', description: 'Recover', parameters: { type: 'object', properties: {} } }
  assert.equal(recoveryIsPublished({ tools: [tool], sections: [] }, tool), true)
  assert.equal(recoveryIsPublished({ tools: [{ ...tool, description: 'different' }], sections: [] }, tool), false)
  const sdk = `interface ToolArgsMap {\n  ${tool.name}: unknown;\n}\ninterface ToolOutputMap {\n  ${tool.name}: string;\n}\ndeclare const tools: {}`
  assert.equal(recoveryIsPublished({ tools: [{ name: 'run_code' }], sections: [{ name: 'tools:sdk', interpolate: false, text: sdk }] }, tool), true)
  assert.equal(recoveryIsPublished({ tools: [{ name: 'run_code' }], sections: [] }, tool), false)
})

test('a newly starting native socket can be retried before any request was sent', unixOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-native-start-'))
  const server = createServer(socket => socket.once('data', () => socket.end(JSON.stringify({ protocol_version: 1, action: 'allow', visibility: 'silent', fail_open: true }) + '\n')))
  try {
    await mkdir(join(directory, 'run'))
    const response = nativeCall(directory, { event: 'fixture' })
    await new Promise(resolve => setTimeout(resolve, 15))
    await new Promise((resolve, reject) => server.listen(nativeSocketPath(directory), resolve).on('error', reject))
    assert.equal((await response)?.action, 'allow')
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-native-start-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('native responses are consumed as soon as a complete line arrives', unixOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-native-line-'))
  const connections = new Set()
  const server = createServer({ allowHalfOpen: true }, socket => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.once('data', () => socket.write(JSON.stringify({ protocol_version: 1, action: 'allow', visibility: 'silent', fail_open: true }) + '\n'))
  })
  try {
    await mkdir(join(directory, 'run'))
    await new Promise((resolve, reject) => server.listen(nativeSocketPath(directory), resolve).on('error', reject))
    const response = await nativeCall(directory, { event: 'fixture' })
    assert.equal(response?.action, 'allow', 'a complete response does not require the server to close its connection')
  } finally {
    for (const connection of connections) connection.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-native-line-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('a late native response has transport slack without repeating the request', unixOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-native-slack-'))
  let requests = 0
  const server = createServer(socket => socket.once('data', () => {
    requests++
    setTimeout(() => socket.end(JSON.stringify({ protocol_version: 1, action: 'allow', visibility: 'silent', fail_open: true }) + '\n'), 350)
  }))
  try {
    await mkdir(join(directory, 'run'))
    await new Promise((resolve, reject) => server.listen(nativeSocketPath(directory), resolve).on('error', reject))
    assert.equal((await nativeCall(directory, { event: 'fixture' }))?.action, 'allow')
    assert.equal(requests, 1)
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-native-slack-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('transient missing native responses do not discard the child session', unixOnly, async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-native-recovery-'))
  const previous = process.env.CAVEMAN_HOME
  const hooks = new Map()
  let cleanup
  let onFileResolve
  const ctx = {
    on(name, callback) { hooks.set(name, callback) },
    effect(callback) { cleanup = callback() },
    get(name) {
      if (name !== 'fs') return undefined
      return {
        resolve: (path, { cwd }) => {
          onFileResolve?.()
          return realpath(resolve(cwd, path))
        },
        processPathFromHostPath: path => path,
        processPath: path => path,
      }
    },
    tools: { get() { return { name: 'mcp__caveman__caveman_retrieve' } } },
  }
  const requests = []
  const missing = new Set(['subagent.start', 'prompt.submit', 'tool.before'])
  let context
  const socketServer = createServer(socket => {
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      if (!buffer.includes('\n')) return
      const request = JSON.parse(buffer)
      requests.push(request)
      if (missing.has(request.event.type)) socket.end()
      else socket.end(JSON.stringify({
        protocol_version: 1, action: 'allow', visibility: 'silent', fail_open: true,
        ...(request.event.type === 'tool.before' && context ? { context } : {}),
      }) + '\n')
    })
  })
  let checks = 0
  let beforeHealthResponse
  const httpServer = createHttpServer(async (_request, response) => {
    checks++
    try { await beforeHealthResponse?.() } catch (error) { response.destroy(error); return }
    response.writeHead(200, { 'x-caveman-instance': 'fixture-instance' }).end()
  })
  try {
    process.env.CAVEMAN_HOME = directory
    await mkdir(join(directory, 'run'))
    await new Promise((resolve, reject) => httpServer.listen(0, '127.0.0.1', resolve).on('error', reject))
    const port = httpServer.address().port
    const runPath = join(directory, 'run', `${port}.json`)
    const runState = { schema: 'caveman.proxy.run.v1', owner: 'start', pid: process.pid, port, instance_token: 'fixture-instance' }
    await writeFile(runPath, JSON.stringify(runState))
    await new Promise((resolve, reject) => socketServer.listen(nativeSocketPath(directory), resolve).on('error', reject))
    registerNative(ctx, `http://127.0.0.1:${port}`, { mode: 'safe', profile: 'full-safe', core: true })
    const agent = { session: { id: 'child', header: { cwd: directory, origin: 'subagent', parentSession: 'parent' } } }
    const signal = new AbortController().signal
    const decision = { kind: 'continue', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect this file.' }] }] }
    await hooks.get('agent/pre-step')({ agent, signal, modelSelection: { provider: 'mock', model: 'mock' } }, async () => decision)
    const result = { content: [{ type: 'text', text: 'fixture result' }] }
    assert.equal(await hooks.get('tools/execute')({ agent, signal, name: 'fixture_tool', arguments: {} }, async () => result), result)
    hooks.get('agent/disposed')({ agent })
    await cleanup()
    assert.deepEqual(requests.map(request => request.event.type), ['session.start', 'subagent.start', 'prompt.submit', 'tool.before', 'tool.after', 'subagent.stop', 'session.end'])
    assert.equal(Buffer.from(requests.find(request => request.event.type === 'tool.after').tool.output, 'base64').toString('utf8'), 'fixture result')

    const firstCount = requests.length
    missing.add('session.start')
    const unconfirmed = { session: { id: 'other-child', header: { cwd: directory, origin: 'subagent', parentSession: 'parent' } } }
    await hooks.get('agent/pre-step')({ agent: unconfirmed, signal, modelSelection: { provider: 'mock', model: 'mock' } }, async () => decision)
    assert.equal(await hooks.get('tools/execute')({ agent: unconfirmed, signal, name: 'fixture_tool', arguments: { private: 'input' } }, async () => result), result)
    hooks.get('agent/disposed')({ agent: unconfirmed })
    await cleanup()
    assert.deepEqual(requests.slice(firstCount).map(request => request.event.type), ['session.start', 'subagent.start', 'prompt.submit', 'subagent.stop', 'session.end'], 'tool input and output stay private until the native peer has replied')

    missing.delete('session.start')
    missing.delete('tool.before')
    const reader = { session: { id: 'reader', header: { cwd: directory } } }
    await writeFile(join(directory, 'file.txt'), 'fixture result')
    await hooks.get('agent/pre-step')({ agent: reader, signal, modelSelection: { provider: 'mock', model: 'mock' } }, async () => decision)
    const read = { agent: reader, signal, name: 'read', arguments: { path: 'file.txt' }, toolSet: {} }
    const execute = hooks.get('tools/execute')
    assert.equal(await execute(read, async () => result), result)
    const [before, after] = requests.slice(-2)
    assert.equal(after.event.type, 'tool.after')
    assert.match(before.tool.input_state, /^sha256:[a-f0-9]{64}$/u)
    assert.equal(after.tool.input_state, before.tool.input_state, 'the first successful read records a reusable observation without a reminder')

    context = 'Current observation already exists: ccr://fixture'
    const unchanged = await execute(read, async () => result)
    assert.equal(unchanged.additionalContexts[0].content[0].text, context)
    assert.equal(await execute(read, async () => {
      await writeFile(join(directory, 'file.txt'), 'updated result')
      return result
    }), result, 'a file changed while reading receives no stale reminder')
    const [changedBefore, changedAfter] = requests.slice(-2)
    assert.match(changedBefore.tool.input_state, /^sha256:[a-f0-9]{64}$/u)
    assert.equal(changedAfter.tool.input_state, undefined, 'unstable output is never recorded under the new state')

    const failure = { ...result, isError: true }
    assert.equal(await execute(read, async () => failure), failure)
    assert.equal(requests.at(-1).event.type, 'tool.failure')
    assert.equal(requests.at(-1).tool.input_state, undefined)

    await t.test('a changed run record invalidates a cached health check before output is sent', async () => {
      assert.equal(checks, 1, 'an unchanged record reuses the recent health check')
      const count = requests.length
      const latest = await execute(read, async () => {
        await writeFile(runPath, JSON.stringify({ ...runState, instance_token: 'changed-instance' }))
        return result
      })
      assert.deepEqual(requests.slice(count).map(request => request.event.type), ['tool.before'])
      assert.equal(latest, result, 'the checked read result passes through without a reminder')
      assert.equal(checks, 2, 'a changed record requires a fresh health check')
      await writeFile(runPath, JSON.stringify(runState))
      const restored = await execute(read, async () => result)
      assert.equal(restored.additionalContexts[0].content[0].text, context)
      assert.equal(checks, 3, 'a restored record must be verified again')
    })

    await t.test('aborting the after-read fingerprint preserves the completed tool result', async () => {
      const controller = new AbortController()
      const count = requests.length
      const latest = await execute({ ...read, signal: controller.signal }, async () => {
        onFileResolve = () => {
          onFileResolve = undefined
          controller.abort()
        }
        return result
      })
      assert.equal(controller.signal.aborted, true)
      assert.equal(latest, result)
      assert.deepEqual(requests.slice(count).map(request => request.event.type), ['tool.before'])
    })

    await t.test('the run record must remain current through a fresh health check', async () => {
      const count = requests.length
      const latest = await execute(read, async () => {
        t.mock.timers.tick(1_001)
        beforeHealthResponse = () => writeFile(runPath, JSON.stringify({ ...runState, instance_token: 'changed-during-health-check' }))
        return result
      })
      assert.equal(checks, 4, 'the expired proof prompts a fresh health check')
      assert.deepEqual(requests.slice(count).map(request => request.event.type), ['tool.before'])
      assert.equal(latest, result)
    })
  } finally {
    if (previous === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previous
    if (socketServer.listening) await new Promise(resolve => socketServer.close(resolve))
    if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-native-recovery-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
