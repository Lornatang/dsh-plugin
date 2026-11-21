import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createNetServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import * as plugin from '../lib/index.js'

const proxyBinary = process.env.CAVEMAN_PROXY_BINARY
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => server.close(resolve))

test('DSH routes Auto and cacheable Anthropic requests through the local proxy', { skip: !proxyBinary, timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-auto-'))
  const home = join(directory, 'state')
  const cloudBodies = []
  const upstreamBodies = []
  let cloud, upstream, tunnel, relay, child, ctx
  const proxyHeaders = []
  const previousKey = process.env.CAVEMAN_TEST_PROVIDER_KEY
  const previousHome = process.env.CAVEMAN_HOME
  try {
    await mkdir(home)
    const key = join(directory, 'key.pem')
    const cert = join(directory, 'cert.pem')
    const opensslConfig = join(directory, 'openssl.cnf')
    await writeFile(opensslConfig, '[req]\ndistinguished_name = dn\n[dn]\n')
    execFileSync('openssl', ['req', '-config', opensslConfig, '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', cert, '-days', '1', '-subj', '/CN=api.openai.com', '-addext', 'subjectAltName=DNS:api.openai.com,DNS:api.anthropic.com'], { stdio: 'ignore' })
    cloud = createHttpServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      if (request.headers['x-cave-warm']) { response.writeHead(204, { 'x-cave-edge-engine': 'warm' }); response.end(); return }
      if (request.url !== '/v1/route') { response.writeHead(404); response.end(); return }
      cloudBodies.push(JSON.parse(raw))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model: 'gpt-6-luna', effort: 'low' }))
    })
    await listen(cloud)
    upstream = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      upstreamBodies.push(JSON.parse(raw))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (request.url?.startsWith('/v1/messages')) {
        const events = [
          ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anthropic fixture answer' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
          ['message_stop', { type: 'message_stop' }],
        ]
        for (const [name, event] of events) response.write(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`)
        response.end()
        return
      }
      const events = [
        { choices: [{ delta: { role: 'assistant', content: '' }, index: 0, finish_reason: null }] },
        { choices: [{ delta: { content: 'fixture answer' }, index: 0, finish_reason: null }] },
        { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      ]
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await listen(upstream)
    tunnel = createHttpServer()
    tunnel.on('connect', (request, client, head) => {
      if (!['api.openai.com:443', 'api.anthropic.com:443'].includes(request.url)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
      const target = connect(upstream.address().port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) target.write(head)
        client.pipe(target).pipe(client)
      })
      target.on('error', () => client.destroy())
      client.on('error', () => target.destroy())
    })
    await listen(tunnel)
    const probe = createNetServer()
    await listen(probe)
    const port = probe.address().port
    await close(probe)
    const cloudUrl = `http://127.0.0.1:${cloud.address().port}`
    const token = `${Buffer.from(JSON.stringify({ uid: 'fixture', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`
    await writeFile(join(home, 'cloud.json'), JSON.stringify({ baseURL: cloudUrl, gatewayUrl: cloudUrl, tokenStore: 'file', deviceId: 'fixture', modules: { routing: true } }))
    await writeFile(join(home, 'credentials'), JSON.stringify({ access_token: token, gateway_api_key: 'fixture-gateway-key' }))
    await writeFile(join(home, 'caveman.yaml'), `mode: record\nupstream_proxy: 'http://127.0.0.1:${tunnel.address().port}'\nca_bundle: '${cert.replaceAll('\\', '/')}'\n`)
    child = spawn(proxyBinary, ['serve'], { windowsHide: true, stdio: 'ignore', env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory, USERPROFILE: directory,
      CAVEMAN_HOME: home, CAVEMAN_CONFIG: join(home, 'caveman.yaml'), CAVEMAN_LISTEN: `127.0.0.1:${port}`,
      DO_NOT_TRACK: '1', CAVE_NO_KEYCHAIN: '1',
    } })
    const endpoint = `http://127.0.0.1:${port}`
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${endpoint}/caveman/v1/middleware/capabilities`)).ok) break } catch {}
      if (attempt === 99 || child.exitCode !== null) throw new Error('proxy did not start')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    relay = createHttpServer((incoming, outgoing) => {
      proxyHeaders.push(incoming.headers)
      const request = httpRequest({ hostname: '127.0.0.1', port, path: incoming.url, method: incoming.method, headers: incoming.headers, agent: false }, response => {
        outgoing.writeHead(response.statusCode ?? 500, response.headers)
        response.pipe(outgoing)
      })
      request.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
      incoming.pipe(request)
    })
    await listen(relay)
    const pluginEndpoint = `http://127.0.0.1:${relay.address().port}`
    process.env.CAVEMAN_TEST_PROVIDER_KEY = 'fixture-provider-key'
    process.env.CAVEMAN_HOME = home
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: false, middlewareEndpoint: pluginEndpoint })
    const example = parseYaml(await readFile(new URL('../examples/caveman-auto.patch.yml', import.meta.url), 'utf8'))
    const profile = example[0].config.providers['caveman-auto']
    profile.baseURL = `${pluginEndpoint}/v1`
    profile.apiKeyEnv = 'CAVEMAN_TEST_PROVIDER_KEY'
    const anthropicExample = parseYaml(await readFile(new URL('../examples/caveman-anthropic.patch.yml', import.meta.url), 'utf8'))
    const anthropic = anthropicExample[0].config.providers['caveman-anthropic']
    anthropic.baseURL = pluginEndpoint
    anthropic.apiKeyEnv = 'CAVEMAN_TEST_PROVIDER_KEY'
    await ctx.plugin(LlmPiAi, { providers: { 'caveman-auto': profile, 'caveman-anthropic': anthropic } })
    const assembler = new BlockAssembler()
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture prompt' }] })
    for await (const chunk of ctx.llm.stream({ provider: 'caveman-auto', model: 'caveman-auto', messages: [message], sessionId: 'test-session' })) assembler.push(chunk)
    assert.match(JSON.stringify(assembler.blocks()), /fixture answer/)
    assert.equal(cloudBodies.length, 1)
    assert.equal(cloudBodies[0].ask.text, 'fixture prompt')
    assert.equal(upstreamBodies.length, 1)
    assert.equal(upstreamBodies[0].model, 'gpt-6-luna')
    assert.equal(upstreamBodies[0].reasoning_effort, 'low')
    assert.match(proxyHeaders[0]['x-cave-session'] ?? '', /^dsh-[a-f0-9]{32}$/u)
    assert.equal(proxyHeaders[0]['x-cave-agent'], 'dsh')
    const anthropicAnswer = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: 'caveman-anthropic', model: 'claude-sonnet-4-5', messages: [message], sessionId: 'other-session' })) anthropicAnswer.push(chunk)
    assert.match(JSON.stringify(anthropicAnswer.blocks()), /anthropic fixture answer/)
    assert.equal(upstreamBodies[1].model, 'claude-sonnet-4-5')
    assert.match(JSON.stringify(upstreamBodies[1]), /cache_control/u)
    assert.match(proxyHeaders[1]['x-cave-session'] ?? '', /^dsh-[a-f0-9]{32}$/u)
    assert.notEqual(proxyHeaders[0]['x-cave-session'], proxyHeaders[1]['x-cave-session'])
  } finally {
    if (ctx) await ctx.fiber.dispose()
    if (previousKey === undefined) delete process.env.CAVEMAN_TEST_PROVIDER_KEY
    else process.env.CAVEMAN_TEST_PROVIDER_KEY = previousKey
    if (previousHome === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previousHome
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill(); await exited
    }
    if (cloud) await close(cloud)
    if (relay) await close(relay)
    if (tunnel) await close(tunnel)
    if (upstream) await close(upstream)
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-auto-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
