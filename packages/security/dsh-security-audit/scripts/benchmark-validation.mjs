import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const skillDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../skills/security-audit'))
const source = { kind: 'entrypoint', file: 'src/handler.c', line: 10, scope: 'handle', description: 'Attacker input reaches the operation.' }
const evidence = { file: 'src/handler.c', line: 10, description: 'The operation lacks the required check.' }

function finding(index, mixed) {
  const common = {
    fingerprint: `finding-${String(index).padStart(4, '0')}`,
    title: 'Missing ownership check',
    description: 'An attacker can reach the operation without the intended ownership check.',
    trace: [{ ...source }],
    evidence: [{ ...evidence }],
  }
  if (mixed && index % 3 === 1) return {
    ...common, verdict: 'needs_validation', claimed_root_cause: 'The ownership check may be missing.',
    blockers: ['The generated source is unavailable.'], validation_plan: { local: 'Inspect the generated source.' },
  }
  if (mixed && index % 3 === 2) return {
    ...common, verdict: 'rejected', claimed_root_cause: 'The ownership check was believed missing.',
    reason: 'The operation performs the ownership check.',
  }
  return {
    ...common, verdict: 'confirmed', root_cause: 'The ownership check is missing.',
    intended_behavior: 'Only the owner can change the object.', conditions: [],
    execution: { attacker_perspective: 'An unprivileged user.', payloads: ['An object ID.'], instructions: ['Submit the ID.'], observed_result: 'The object changes.' },
    remediation: { strategy: 'Check ownership before changing the object.' },
    severity: { likelihood: { score: 'medium', reason: 'Directly reachable.' }, impact: { score: 'medium', reason: 'One object changes.' }, overall_severity: 'medium' },
    confidence: { score: 'high', reason: 'The behavior was reproduced.' },
  }
}

if (process.platform === 'win32') {
  const { readFileWithinLimit } = require(join(skillDir, 'windows-safe-input.cjs'))
  const file = join(tmpdir(), `dsh-security-audit-benchmark-${randomUUID()}.json`)
  const input = 'a'.repeat(4 * 1024 * 1024)
  writeFileSync(file, input, { flag: 'wx' })
  try {
    const samples = []
    for (let run = 0; run < 15; run++) {
      const start = performance.now()
      const output = readFileWithinLimit(file, 5 * 1024 * 1024)
      const elapsed = performance.now() - start
      assert.equal(output, input)
      if (run >= 3) samples.push(elapsed)
    }
    samples.sort((a, b) => a - b)
    console.log(`Windows 4 MiB read: ${samples.length} runs, median ${((samples[5] + samples[6]) / 2).toFixed(2)} ms`)
  } finally {
    unlinkSync(file)
  }
}

for (const mixed of [false, true]) {
  const data = Array.from({ length: 1000 }, (_, index) => finding(index, mixed))
  const file = join(tmpdir(), `dsh-security-audit-benchmark-${randomUUID()}.json`)
  writeFileSync(file, JSON.stringify(data), { flag: 'wx' })
  try {
    const samples = []
    for (let run = 0; run < 12; run++) {
      const start = performance.now()
      const result = spawnSync(process.execPath, [join(skillDir, 'validate-findings.cjs'), file], { encoding: 'utf8', timeout: 15000 })
      const elapsed = performance.now() - start
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      assert.match(result.stdout, /PASS: 1000 findings valid/u)
      if (run >= 3) samples.push(elapsed)
    }
    samples.sort((a, b) => a - b)
    console.log(`${mixed ? 'mixed' : 'confirmed'} CLI: ${samples.length} runs, median ${samples[4].toFixed(2)} ms`)
  } finally {
    unlinkSync(file)
  }
}
