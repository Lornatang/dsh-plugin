import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fixtures = new URL('../benchmarks/review-quality/', import.meta.url)
const verdicts = new Set(['source_supported', 'rejected', 'needs_validation'])
const costFields = new Set(['elapsedMs', 'agentInvocations', 'inputTokens', 'outputTokens'])

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function prepare(cases, directory) {
  mkdirSync(directory)
  for (const { id, contract, source } of cases) {
    const numbered = source.map((line, index) => `${index + 1} | ${line}`).join('\n')
    const packet = [
      `# Review case ${id}`,
      '',
      'Apply your review workflow’s evidence rules while inspecting the supplied toy source. Assume all object arguments are plain, non-proxy JavaScript objects whose own properties are data properties. Use the following verdicts for this static review.',
      '',
      '- `source_supported`: The supplied source establishes a violation of the stated contract.',
      '- `rejected`: The source establishes that the implementation satisfies the contract.',
      '- `needs_validation`: A specific missing fact prevents a decision.',
      '',
      'Return one JSON object with the shape below. Replace the verdict and reason placeholders. Put the decisive source line numbers in `lines`. Explain the behavior or name the missing fact in `reason`.',
      '',
      `{"id": "${id}", "verdict": "<verdict>", "lines": [], "reason": "<reason>"}`,
      '',
      '## Contract',
      '',
      contract,
      '',
      '## Supplied source',
      '',
      '```text',
      numbered,
      '```',
      '',
    ].join('\n')
    writeFileSync(join(directory, `${id}.md`), packet, { flag: 'wx' })
  }
}

function ratio(count, total) {
  return { count, total, rate: total ? count / total : null }
}

function metric(items, predicate) {
  return ratio(items.filter(predicate).length, items.length)
}

function score(cases, labels, result) {
  if (!Array.isArray(result?.decisions)) throw new Error('Expected a decisions array.')
  const { decisions, reviewer = null, cost = null } = result
  if (reviewer !== null && (typeof reviewer !== 'string' || !reviewer.trim())) {
    throw new Error('Reviewer must be a nonempty string.')
  }
  if (cost !== null && (typeof cost !== 'object' || Array.isArray(cost) ||
    Object.entries(cost).some(([field, value]) =>
      !costFields.has(field) || !Number.isSafeInteger(value) || value < 0))) {
    throw new Error('Cost fields must use the documented names and nonnegative integers.')
  }

  const caseIds = new Set(cases.map(({ id }) => id))
  const byId = new Map()
  for (const decision of decisions) {
    if (!caseIds.has(decision?.id)) throw new Error(`Unknown case ID: ${decision?.id}.`)
    const { id, verdict, lines, reason } = decision
    if (byId.has(id)) throw new Error(`Duplicate decision for ${id}.`)
    if (!verdicts.has(verdict) || !Array.isArray(lines) ||
      lines.some((line) => !Number.isSafeInteger(line) || line < 1) ||
      typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`Invalid decision for ${id}.`)
    }
    byId.set(id, decision)
  }

  const rows = cases.map(({ id, source }) => {
    const decision = byId.get(id)
    if (!decision) throw new Error(`Missing decision for ${id}.`)
    const { expectedVerdict, anchorLines, rationale } = labels[id]
    const { verdict, lines, reason } = decision
    const citedLines = [...new Set(lines)]
    const outOfRangeLines = citedLines.filter((line) => line > source.length)
    const missingLines = anchorLines.filter((line) => !citedLines.includes(line))
    const decisiveCitations = verdict === expectedVerdict &&
      outOfRangeLines.length === 0 && missingLines.length === 0
    const citationPrecision = metric(citedLines, (line) => anchorLines.includes(line))
    return {
      id, verdict, expectedVerdict, reason, rationale, lines: citedLines,
      missingLines, outOfRangeLines, decisiveCitations, citationPrecision,
    }
  })
  const supported = rows.filter((row) => row.expectedVerdict === 'source_supported')
  const clean = rows.filter((row) => row.expectedVerdict === 'rejected')
  const unresolved = rows.filter((row) => row.expectedVerdict === 'needs_validation')
  const decisiveLineCount = rows.reduce((count, row) => count + row.citationPrecision.count, 0)
  const citedLineCount = rows.reduce((count, row) => count + row.citationPrecision.total, 0)
  return {
    benchmark: 'state-contracts-v1',
    reviewer,
    knownCaseRecall: metric(supported, (row) => row.verdict === 'source_supported'),
    cleanControlFalsePositiveRate: metric(clean, (row) => row.verdict === 'source_supported'),
    cleanControlRejectionRate: metric(clean, (row) => row.verdict === 'rejected'),
    unresolvedRetentionRate: metric(unresolved, (row) => row.verdict === 'needs_validation'),
    unresolvedMisclassifiedAsSupported: unresolved.filter((row) => row.verdict === 'source_supported').length,
    decisiveCitationRate: metric(rows, (row) => row.decisiveCitations),
    citationPrecision: ratio(decisiveLineCount, citedLineCount),
    cost,
    cases: rows,
  }
}

try {
  const [command, path, ...extra] = process.argv.slice(2)
  if (!path || extra.length || (command !== 'prepare' && command !== 'score')) {
    throw new Error('Usage: node scripts/benchmark-review-quality.mjs prepare <new-directory> | score <results.json>')
  }
  const cases = readJson(new URL('cases.json', fixtures))
  if (command === 'prepare') {
    prepare(cases, path)
  } else {
    const labels = readJson(new URL('labels.json', fixtures))
    const report = score(cases, labels, readJson(path))
    console.log(JSON.stringify(report, null, 2))
  }
} catch (error) {
  console.error(`Benchmark error: ${error.message}`)
  process.exitCode = 1
}
