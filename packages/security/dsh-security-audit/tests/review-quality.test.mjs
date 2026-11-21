import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../scripts/benchmark-review-quality.mjs', import.meta.url))

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
}

function tempDir(t) {
  const path = mkdtempSync(join(tmpdir(), 'dsh-review-quality-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('prepare writes one reproducible reviewer packet per case without including the answer key', (t) => {
  const dir = tempDir(t)
  const first = join(dir, 'first')
  const second = join(dir, 'second')
  const prepared = run('prepare', first)
  assert.equal(prepared.status, 0, prepared.stderr)
  assert.equal(run('prepare', second).status, 0)

  const names = ['r17.md', 'r28.md', 'r43.md', 'r61.md', 'r76.md']
  assert.deepEqual(readdirSync(first).sort(), names)
  for (const name of names) {
    const packet = readFileSync(join(first, name), 'utf8')
    const id = name.slice(0, -3)
    assert.equal(packet, readFileSync(join(second, name), 'utf8'))
    assert.match(packet, /1 \| /u)
    assert.match(packet, /`source_supported`/u)
    assert.doesNotMatch(packet, /`confirmed`/u)
    assert.ok(packet.includes(`"id": "${id}"`))
    assert.ok(names.filter((other) => other !== name).every((other) => !packet.includes(other.slice(0, -3))))
    assert.doesNotMatch(packet, /anchorLines|expectedVerdict|answer key/u)
  }
  assert.notEqual(run('prepare', first).status, 0)
})

const decisions = [
  { id: 'r17', verdict: 'rejected', lines: [2], reason: 'Returns a copy.' },
  { id: 'r28', verdict: 'source_supported', lines: [2, 3], reason: 'Always returns an incremented count.' },
  { id: 'r43', verdict: 'needs_validation', lines: [1, 4], reason: 'The formatter implementation is unavailable.' },
  { id: 'r61', verdict: 'source_supported', lines: [2], reason: 'Updates the supplied draft.' },
  { id: 'r76', verdict: 'rejected', lines: [2, 3], reason: 'Increments only if accepted.' },
]

test('score tracks verdicts, decisive citations, and recorded costs', (t) => {
  const file = join(tempDir(t), 'results.json')
  const cost = { elapsedMs: 2000, agentInvocations: 5, inputTokens: 5200, outputTokens: 760 }
  writeFileSync(file, JSON.stringify({ reviewer: 'Scorer smoke fixture', decisions, cost }))
  const result = run('score', file)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.reviewer, 'Scorer smoke fixture')
  assert.deepEqual(report.knownCaseRecall, { count: 2, total: 2, rate: 1 })
  assert.deepEqual(report.cleanControlFalsePositiveRate, { count: 0, total: 2, rate: 0 })
  assert.deepEqual(report.cleanControlRejectionRate, { count: 2, total: 2, rate: 1 })
  assert.deepEqual(report.unresolvedRetentionRate, { count: 1, total: 1, rate: 1 })
  assert.equal(report.unresolvedMisclassifiedAsSupported, 0)
  assert.deepEqual(report.decisiveCitationRate, { count: 5, total: 5, rate: 1 })
  assert.deepEqual(report.citationPrecision, { count: 8, total: 8, rate: 1 })
  assert.deepEqual(report.cost, cost)
})

test('score distinguishes missed defects, false positives, unsupported verdicts, and weak citations', (t) => {
  const file = join(tempDir(t), 'results.json')
  writeFileSync(file, JSON.stringify({ decisions: [
    { ...decisions[0], verdict: 'source_supported' },
    { ...decisions[1], verdict: 'needs_validation' },
    { ...decisions[2], verdict: 'source_supported' },
    { ...decisions[3], lines: [1, 99] },
    decisions[4],
  ] }))
  const result = run('score', file)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.knownCaseRecall, { count: 1, total: 2, rate: 0.5 })
  assert.deepEqual(report.cleanControlFalsePositiveRate, { count: 1, total: 2, rate: 0.5 })
  assert.deepEqual(report.cleanControlRejectionRate, { count: 1, total: 2, rate: 0.5 })
  assert.deepEqual(report.unresolvedRetentionRate, { count: 0, total: 1, rate: 0 })
  assert.equal(report.unresolvedMisclassifiedAsSupported, 1)
  assert.deepEqual(report.decisiveCitationRate, { count: 1, total: 5, rate: 0.2 })
  assert.deepEqual(report.citationPrecision, { count: 7, total: 9, rate: 7 / 9 })
  assert.deepEqual(report.cases.find(({ id }) => id === 'r61').outOfRangeLines, [99])
  assert.equal(report.cost, null)
})

test('citing every line earns full anchor coverage and lower citation precision', (t) => {
  const file = join(tempDir(t), 'results.json')
  const citations = [[1, 2, 2, 3], [1, 2, 3, 4], [1, 2, 3, 4, 5], [1, 2, 3, 4], [1, 2, 3, 4]]
  writeFileSync(file, JSON.stringify({ decisions: decisions.map((decision, index) => ({
    ...decision, lines: citations[index],
  })) }))
  const result = run('score', file)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.decisiveCitationRate, { count: 5, total: 5, rate: 1 })
  assert.deepEqual(report.citationPrecision, { count: 8, total: 20, rate: 0.4 })
  assert.deepEqual(report.cases[0].citationPrecision, { count: 1, total: 3, rate: 1 / 3 })
})

test('score rejects missing, duplicate, unknown, and malformed case decisions', (t) => {
  const file = join(tempDir(t), 'results.json')
  const invalidInputs = [
    { decisions: decisions.slice(1) },
    { decisions: [decisions[1], ...decisions.slice(1)] },
    { decisions: [{ ...decisions[0], id: 'extra' }, ...decisions.slice(1)] },
    { decisions: [{ ...decisions[0], lines: ['2'] }, ...decisions.slice(1)] },
    { decisions: [{ ...decisions[0], verdict: 'confirmed' }, ...decisions.slice(1)] },
    { decisions, cost: { elapsedMs: -1 } },
  ]
  for (const input of invalidInputs) {
    writeFileSync(file, JSON.stringify(input))
    const result = run('score', file)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /^Benchmark error: /u)
  }
})
