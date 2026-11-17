import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { findDesktopHost } from './find-dsh.mjs'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'dsh-security-audit-install-'))
const desktop = findDesktopHost()
const executable = process.env.DSH_TEST_EXECUTABLE || desktop?.executable || 'dsh'
const entry = process.env.DSH_TEST_ENTRY || desktop?.entry
const prefix = entry ? ['--expose-internals', entry] : []
const env = { ...process.env, DSH_HOME: join(temp, 'dsh-home') }
if (entry) env.ELECTRON_RUN_AS_NODE = '1'
delete env.DSH_PROFILE
const dsh = args => run(executable, [...prefix, ...args], { env, cwd: temp, timeout: 240000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
const npmCli = process.env.npm_execpath || (process.platform === 'win32'
  ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined)
const npm = args => npmCli
  ? run(process.execPath, [npmCli, ...args], { env, cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  : run('npm', args, { env, cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
let server
let output = ''
try {
  const version = (await dsh(['--version'])).stdout.trim()
  assert.ok(version, 'DSH did not report a version')
  await dsh(['--profile', 'security-audit-test', '--from-default-profile', 'web', '--dump-config'])
  const result = JSON.parse((await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp])).stdout)
  const packed = Array.isArray(result) ? result[0] : Object.values(result)[0]
  assert.ok(packed?.filename, 'npm pack did not return a filename')
  await dsh(['plugin', '--profile', 'security-audit-test', 'add', join(temp, packed.filename), '--registry=https://registry.npmjs.org/'])
  const profile = join(env.DSH_HOME, 'profiles', 'security-audit-test')
  const installedRoot = join(profile, 'node_modules', '@lornatang', 'dsh-security-audit')
  const installed = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  assert.equal(installed.name, '@lornatang/dsh-security-audit')
  const original = await readFile(join(root, 'skills', 'security-audit', 'SKILL.md'))
  assert.deepEqual(await readFile(join(installedRoot, 'skills', 'security-audit', 'SKILL.md')), original)
  const input = join(temp, 'input.json')
  await writeFile(input, '[]')
  for (const script of ['validate-findings.cjs', 'validate-coverage-ledger.cjs']) {
    const result = await run(process.execPath, [join(installedRoot, 'skills', 'security-audit', script), input], { env, cwd: temp, timeout: 30000 })
    assert.match(result.stdout, /PASS:/u, `${script} did not validate an installed input`)
  }
  const composed = (await dsh(['--profile', 'security-audit-test', '--dump-config'])).stdout
  assert.ok(composed.includes('@lornatang/dsh-security-audit'), 'bundle was not composed into the profile')
  server = spawn(executable, [...prefix, '--profile', 'security-audit-test', '--no-open', '--port', '0'], {
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
  console.log(`DSH ${version}: packed bundle installed, composed, and booted in an isolated profile.`)
} catch (error) {
  const diagnostics = output.split('\n').filter(line => /security-audit|warning|error/i.test(line) && !/token|https?:\/\//i.test(line)).slice(-20)
  if (diagnostics.length) process.stderr.write(diagnostics.join('\n') + '\n')
  throw error
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(done => server.once('exit', done))
    server.kill()
    await Promise.race([exited, delay(5000)])
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited }
  }
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !temp.includes('dsh-security-audit-install-')) throw new Error('unexpected test directory')
  await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}
