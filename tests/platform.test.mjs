import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const safeOpen = Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW !== 0 &&
  Number.isInteger(constants.O_NONBLOCK) && constants.O_NONBLOCK !== 0

test('validators fail closed on unsupported platforms', { skip: safeOpen || process.platform === 'win32' }, () => {
  const directory = new URL('../skills/security-audit/', import.meta.url)
  for (const script of ['validate-findings.cjs', 'validate-coverage-ledger.cjs']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, directory)), fileURLToPath(new URL('report-schema.json', directory))], { encoding: 'utf8' })
    assert.equal(result.status, 1, script)
    assert.match(result.stderr, /OS no-follow and nonblocking input protection is unavailable/u, script)
  }
})
