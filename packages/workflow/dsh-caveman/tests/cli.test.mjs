import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('the package command forwards CLI arguments and exit status', () => {
  const wrapper = fileURLToPath(new URL('../scripts/caveman-cli.mjs', import.meta.url))
  const original = fileURLToPath(new URL('../node_modules/@caveman-ai/cli/dist/index.js', import.meta.url))
  const options = { encoding: 'utf8', env: { ...process.env, DISABLE_TELEMETRY: '1' } }
  const expected = spawnSync(process.execPath, [original, '--help'], options)
  const actual = spawnSync(process.execPath, [wrapper, '--help'], options)
  assert.equal(expected.status, 0)
  assert.equal(actual.status, expected.status)
  assert.equal(actual.stdout, expected.stdout)
  assert.equal(actual.stderr, expected.stderr)
})
