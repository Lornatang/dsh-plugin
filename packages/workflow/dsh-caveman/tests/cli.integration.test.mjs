import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { verifiedRuntime } from '../lib/runtime.js'

const binary = process.env.CAVEMAN_PROXY_BINARY
const script = fileURLToPath(new URL('../scripts/caveman-cli.mjs', import.meta.url))
const run = promisify(execFile)

test('the packaged CLI configures and starts a compressing local runtime', { skip: !binary, timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-cli-'))
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory,
    HOME: directory, USERPROFILE: directory, CAVEMAN_HOME: directory, CAVEMAN_PROXY_BIN: binary,
    DO_NOT_TRACK: '1', CAVE_NO_KEYCHAIN: '1', NO_COLOR: '1',
  }
  const cli = (...args) => run(process.execPath, [script, ...args], { env, timeout: 15_000, windowsHide: true })
  let child, port
  try {
    await cli('tools', 'config', 'set', 'think.mode', 'compress')
    const configured = await cli('tools', 'config', 'get', 'think.mode')
    assert.match(configured.stdout, /compress/u)
    const probe = createServer()
    await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).on('error', reject))
    port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    child = spawn(process.execPath, [script, 'start', '--port', String(port)], { env, stdio: 'ignore', windowsHide: true })
    const endpoint = `http://127.0.0.1:${port}`
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await verifiedRuntime(endpoint, env)) break
      if (child.exitCode !== null || attempt === 99) throw new Error('CLI runtime did not start')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const capabilities = await (await fetch(`${endpoint}/caveman/v1/middleware/capabilities`)).json()
    assert.equal(capabilities.mode, 'compress')
  } finally {
    if (child && port) {
      const endpoint = `http://127.0.0.1:${port}`
      if (await verifiedRuntime(endpoint, env)) {
        const state = JSON.parse(await readFile(join(directory, 'run', `${port}.json`), 'utf8'))
        if (state.shutdown_token) await fetch(`${endpoint}/caveman/shutdown`, { method: 'POST', headers: { 'x-caveman-shutdown': state.shutdown_token } }).catch(() => {})
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 5000)
            timer.unref()
            child.once('exit', () => { clearTimeout(timer); resolve() })
          })
        }
        if (child.exitCode === null && child.signalCode === null && await verifiedRuntime(endpoint, env)) process.kill(state.pid, 'SIGTERM')
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-cli-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
