#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@caveman-ai/cli/package.json')), 'dist', 'index.js')
const args = process.argv.slice(2)
let learnBinary
if (args[0] === 'learn' && !['--help', '-h', 'help'].includes(args[1])) {
  try { learnBinary = await (await import('./learn-binary.mjs')).resolveLearnBinary() }
  catch (error) { console.error(`dsh-caveman: ${error.message}`); process.exit(1) }
}
const direct = learnBinary && args[1] === 'locate'
const child = spawn(direct ? learnBinary : process.execPath, direct ? args : [cli, ...args], {
  stdio: 'inherit', windowsHide: true,
  env: learnBinary ? { ...process.env, CAVEMAN_PROXY_BIN: learnBinary } : process.env,
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal) })
}
child.once('error', error => {
  console.error(`dsh-caveman: could not start the CLI: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)
})
