import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startMockMcp } from '../tests/mock-mcp.mjs'
import { verifyBrowser } from './browser-smoke.mjs'

const run = promisify(execFile)
const runNpm = (args, options) => process.env.npm_execpath ? run(process.execPath, [process.env.npm_execpath, ...args], options) : run('npm', args, options)
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'github-dsh-integration-'))
const home = join(temp, 'home')
const dshHome = join(temp, 'dsh-home')
const executable = process.env.DSH_TEST_HOST || process.env.DSH_TEST_BINARY || 'dsh'
const prefix = process.env.DSH_TEST_CLI ? ['--expose-internals', process.env.DSH_TEST_CLI] : []
const env = { ...process.env, HOME: home, DSH_HOME: dshHome, DSH_GITHUB_ENCRYPTION_KEY: randomBytes(32).toString('base64') }
if (process.env.DSH_TEST_CLI) env.ELECTRON_RUN_AS_NODE = '1'
delete env.DSH_PROFILE
const dshRun = (args, options = {}) => run(executable, [...prefix, ...args], { env, cwd: temp, windowsHide: true, maxBuffer: 1024 * 1024, ...options })
const mock = await startMockMcp()
let server
let output = ''
try {
  await mkdir(home, { recursive: true })
  const version = (await dshRun(['--version'], { timeout: 30000 })).stdout.trim()
  assert.ok(version, 'DSH did not report its version')
  await dshRun(['--profile', 'github-test', '--from-default-profile', 'web', '--dump-config'], { timeout: 60000 })
  const profile = join(dshHome, 'profiles', 'github-test')
  const packOutput = JSON.parse((await runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, env, timeout: 30000 })).stdout)
  const packed = Array.isArray(packOutput) ? packOutput[0] : Object.values(packOutput)[0]
  assert.ok(packed?.filename, 'npm pack did not return a package')
  await dshRun(['plugin', '--profile', 'github-test', 'add', join(temp, packed.filename), '--registry=https://registry.npmjs.org/'], { timeout: 240000 })
  const installed = JSON.parse(await readFile(join(profile, 'node_modules', '@lornatang', 'dsh-github', 'package.json'), 'utf8'))
  const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(installed.version, expected.version)
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: github\n  config:\n    serverName: github\n    url: '${mock.url}'\n    toolsets: 'repos,issues'\n    readOnly: false\n    credentialSource: saved\n`)
  server = spawn(executable, [...prefix, '--profile', 'github-test', '--no-open', '--port', '0'], { env, cwd: temp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (chunk) => { output += chunk })
  server.stderr.on('data', (chunk) => { output += chunk })
  let launch
  for (let i = 0; i < 900; i++) {
    launch = output.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
    if (launch) break
    if (server.exitCode !== null) throw new Error('DSH exited during startup')
    await delay(100)
  }
  assert.ok(launch, 'DSH did not print an authenticated launch URL')
  const origin = new URL(launch).origin
  assert.equal((await fetch(origin + '/plugins/github/status')).status, 401)
  assert.ok([401, 403].includes((await fetch(origin + '/plugins/github/disconnect', { method: 'POST' })).status))
  const entry = await fetch(launch, { redirect: 'manual' })
  const cookie = entry.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'DSH did not issue a login cookie')
  assert.ok([401, 403].includes((await fetch(origin + '/plugins/github/disconnect', { method: 'POST', headers: { cookie, origin: 'https://example.invalid' } })).status))
  let status
  for (let i = 0; i < 300; i++) {
    const response = await fetch(origin + '/plugins/github/status', { headers: { cookie }, signal: AbortSignal.timeout(10000) })
    if (response.status === 200) { status = await response.json(); break }
    await delay(100)
  }
  assert.equal(status?.status, 'idle', `plugin did not start: ${status?.error || 'no status'}`)
  assert.equal(status?.oauthAvailable, true, 'The bundled GitHub OAuth app must enable browser sign-in by default')
  const connected = await fetch(origin + '/plugins/github/connect', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ source: 'token', token: 'testtoken' }) })
  assert.equal(connected.status, 200)
  status = await connected.json()
  assert.equal(status.status, 'ready', `MCP bridge did not become ready: ${status.error || 'no status'}`)
  assert.equal(status.toolCount, 3)
  const file = (await readdir(join(profile, 'data'))).find((name) => name.startsWith('dsh-github-github-'))
  assert.ok(file, 'encrypted credentials must be in the active profile')
  assert.doesNotMatch(await readFile(join(profile, 'data', file), 'utf8'), /testtoken/)
  await verifyBrowser(launch, temp)
  const disconnected = await fetch(origin + '/plugins/github/disconnect', { method: 'POST', headers: { cookie, origin } })
  assert.equal(disconnected.status, 200)
  assert.equal((await disconnected.json()).toolCount, 0)
  console.log(`DSH ${version}: installation, request fence, MCP tools and encrypted credentials passed.`)
} catch (error) {
  const diagnostics = output.split('\n').filter((line) => /github|warning|error/i.test(line) && !/token|https?:\/\//i.test(line)).slice(-20)
  if (diagnostics.length) process.stderr.write(diagnostics.join('\n') + '\n')
  throw error
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve))
    server.kill('SIGTERM')
    await Promise.race([exited, delay(5000)])
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited }
  }
  await mock.close()
  await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}
