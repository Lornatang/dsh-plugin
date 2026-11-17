import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'

const safeOpen = Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW !== 0 &&
  Number.isInteger(constants.O_NONBLOCK) && constants.O_NONBLOCK !== 0
const args = ['--test']
if (!safeOpen) {
  console.log('Safe no-follow input opening is unavailable; skipping upstream CLI tests and checking fail-closed behavior instead.')
  args.push('--test-skip-pattern=CLI')
}
args.push('tests/*.test.mjs', 'upstream/skills/security-audit/*.test.cjs')
const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
