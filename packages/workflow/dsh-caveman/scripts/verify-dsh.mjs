import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'dsh-caveman-install-'))
const executable = process.env.DSH_TEST_EXECUTABLE || 'dsh'
const prefix = process.env.DSH_TEST_ENTRY ? ['--expose-internals', process.env.DSH_TEST_ENTRY] : []
const env = { ...process.env, DSH_HOME: join(temp, 'dsh-home'), CAVEMAN_HOME: join(temp, 'caveman-home') }
await mkdir(env.CAVEMAN_HOME)
await writeFile(join(env.CAVEMAN_HOME, 'cloud.json'), JSON.stringify({ modules: { browse: false, scripts: false }, execute: { mcp: false } }))
if (process.env.DSH_TEST_ENTRY) env.ELECTRON_RUN_AS_NODE = '1'
delete env.DSH_PROFILE
const dsh = args => run(executable, [...prefix, ...args], { env, cwd: temp, timeout: 240000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
const npmCli = process.env.npm_execpath || (process.platform === 'win32'
  ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined)
const npm = args => npmCli
  ? run(process.execPath, [npmCli, ...args], { env, cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  : run('npm', args, { env, cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
let server
let output = ''
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return
  const exited = new Promise(resolve => server.once('exit', resolve))
  server.kill()
  await Promise.race([exited, delay(5000)])
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited }
}
try {
  const version = (await dsh(['--version'])).stdout.trim()
  assert.ok(version, 'DSH did not report a version')
  await dsh(['--profile', 'caveman-test', '--from-default-profile', 'web', '--dump-config'])
  const result = JSON.parse((await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp])).stdout)
  const packed = Array.isArray(result) ? result[0] : Object.values(result)[0]
  assert.ok(packed?.filename, 'npm pack did not return a filename')
  await dsh(['plugin', '--profile', 'caveman-test', 'add', join(temp, packed.filename), '--registry=https://registry.npmjs.org/'])
  const profile = join(env.DSH_HOME, 'profiles', 'caveman-test')
  const installed = JSON.parse(await readFile(join(profile, 'node_modules', '@lornatang', 'dsh-caveman', 'package.json'), 'utf8'))
  assert.equal(installed.name, '@lornatang/dsh-caveman')
  for (const role of ['investigator', 'builder', 'reviewer']) {
    const path = join(profile, 'node_modules', '@lornatang', 'dsh-caveman', 'vendor', 'caveman', 'agents', `cavecrew-${role}.md`)
    assert.ok((await readFile(path, 'utf8')).includes(`name: cavecrew-${role}`), `missing ${role} persona`)
  }
  const composed = (await dsh(['--profile', 'caveman-test', '--dump-config'])).stdout
  assert.ok(composed.includes('@lornatang/dsh-caveman'), 'bundle was not composed into the profile')
  for (const role of ['investigator', 'builder', 'reviewer']) {
    assert.ok(composed.includes(`preset-cavecrew-${role}`), `missing ${role} preset`)
    assert.ok(composed.includes(`tool-cavecrew-${role}`), `missing ${role} delegation tool`)
  }
  server = spawn(executable, [...prefix, '--profile', 'caveman-test', '--no-open', '--port', '0'], {
    env, cwd: temp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', chunk => { output += chunk })
  server.stderr.on('data', chunk => { output += chunk })
  let launch
  for (let attempt = 0; attempt < 600; attempt++) {
    launch = output.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
    if (launch) break
    if (server.exitCode !== null) throw new Error('DSH exited while loading the package')
    await delay(100)
  }
  assert.ok(launch, 'DSH did not start the installed profile')
  const response = await fetch(new URL(launch).origin, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  assert.ok(response.status < 500, `DSH returned HTTP ${response.status}`)
  await stopServer()
  await dsh(['plugin', '--profile', 'caveman-test', 'remove', '@lornatang/dsh-caveman'])
  const removed = (await dsh(['--profile', 'caveman-test', '--dump-config'])).stdout
  assert.ok(!removed.includes('@lornatang/dsh-caveman'), 'bundle was not removed from the profile')
  assert.ok(!removed.includes('preset-cavecrew-investigator'), 'Cavecrew presets were not removed from the profile')
  console.log(`DSH ${version}: packed bundle installed, composed, booted, and removed in an isolated profile.`)
} catch (error) {
  const diagnostics = output.split('\n').filter(line => /caveman|warning|error/i.test(line) && !/token|https?:\/\//i.test(line)).slice(-20)
  if (diagnostics.length) process.stderr.write(diagnostics.join('\n') + '\n')
  throw error
} finally {
  await stopServer()
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !temp.includes('dsh-caveman-install-')) throw new Error('unexpected test directory')
  await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}
