import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

interface Counts {
  activity: boolean
  messages: number
  usageReports: number
  output: number
  cacheReports: number
  cacheRead: number
  attempted: number
  modes: Map<string, { messages: number; reports: number; output: number }>
}

function countsFor(events: readonly SessionEvent[], cutoff?: number): Counts {
  const counts: Counts = { activity: false, messages: 0, usageReports: 0, output: 0, cacheReports: 0, cacheRead: 0, attempted: 0, modes: new Map() }
  let mode = 'unattributed'
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'dsh-caveman-mode') mode = event.data.source.mode
    if (cutoff !== undefined && (!Number.isFinite(event.time) || event.time < cutoff)) continue
    counts.activity = true
    if (event.type === 'assistant/attempt') counts.attempted++
    if (event.type !== 'assistant/message') continue
    counts.messages++
    const group = counts.modes.get(mode) ?? { messages: 0, reports: 0, output: 0 }
    group.messages++
    const usage = event.data.usage
    if (usage && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0) {
      counts.usageReports++
      counts.output += usage.outputTokens
      group.reports++
      group.output += usage.outputTokens
    }
    if (usage && Number.isSafeInteger(usage.cacheReadTokens) && usage.cacheReadTokens! >= 0) {
      counts.cacheReports++
      counts.cacheRead += usage.cacheReadTokens!
    }
    counts.modes.set(mode, group)
  }
  return counts
}

function mergeCounts(target: Counts, source: Counts): void {
  target.activity ||= source.activity
  target.messages += source.messages
  target.usageReports += source.usageReports
  target.output += source.output
  target.cacheReports += source.cacheReports
  target.cacheRead += source.cacheRead
  target.attempted += source.attempted
  for (const [mode, group] of source.modes) {
    const current = target.modes.get(mode) ?? { messages: 0, reports: 0, output: 0 }
    current.messages += group.messages
    current.reports += group.reports
    current.output += group.output
    target.modes.set(mode, current)
  }
}

function available(value: number, reports: number, messages: number): string {
  if (!reports) return 'unavailable'
  return reports < messages ? `${value} known (partial; total unavailable)` : String(value)
}

function sharedReport(counts: Counts): string {
  return `Caveman: ${counts.messages} recorded assistant messages, ${available(counts.output, counts.usageReports, counts.messages)} output tokens; savings unknown.`
}

function linesFor(counts: Counts): string[] {
  const lines = [
    `Recorded assistant messages: ${counts.messages}`,
    `Messages with usage: ${counts.usageReports} of ${counts.messages}`,
    `Output tokens: ${available(counts.output, counts.usageReports, counts.messages)}`,
    `Cache-read tokens: ${available(counts.cacheRead, counts.cacheReports, counts.messages)} (${counts.cacheReports} of ${counts.messages} messages reported cache reads)`,
    `Uncommitted assistant attempts excluded: ${counts.attempted}`,
  ]
  if (counts.modes.size) {
    lines.push('Output tokens by response mode:')
    for (const [mode, group] of [...counts.modes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      lines.push(`  ${mode}: ${available(group.output, group.reports, group.messages)}`)
    }
  }
  lines.push('Savings: unknown (no comparison without Caveman)')
  return lines
}

interface StatsOptions { all: boolean; share: boolean; since?: { label: string; milliseconds: number } }

function parseOptions(flags: string): StatsOptions {
  const result: StatsOptions = { all: false, share: false }
  const args = flags.match(/\S+/gu) ?? []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--all') result.all = true
    else if (arg === '--share') result.share = true
    else if (arg === '--since') {
      const match = /^(\d+)([dh])$/u.exec(args[++index] ?? '')
      const quantity = Number(match?.[1])
      if (!match || !Number.isSafeInteger(quantity)) throw new Error('--since takes Nh or Nd (for example, 24h or 7d)')
      const milliseconds = quantity * (match[2] === 'd' ? 86_400_000 : 3_600_000)
      if (!Number.isSafeInteger(milliseconds)) throw new Error('--since duration is too large')
      result.since = { label: match[0], milliseconds }
    } else throw new Error(`Unknown statistics option: ${arg}`)
  }
  return result
}

function formatSessionStats(events: readonly SessionEvent[], options: StatsOptions): string {
  const counts = countsFor(events)
  return options.share ? sharedReport(counts) : ['DSH session usage (recorded assistant messages only)', ...linesFor(counts)].join('\n')
}

/** Report recorded message usage without claiming savings or unreported counts. */
export function sessionStats(events: readonly SessionEvent[], flags: string): string {
  return formatSessionStats(events, parseOptions(flags))
}

/** Aggregate each live or stored session once, excluding fork-inherited events. */
export async function statsReport(ctx: Context, current: Session, flags: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let options: StatsOptions
  try { options = parseOptions(flags) } catch (error) { return (error as Error).message }
  if (!options.all && !options.since) return formatSessionStats(current.snapshotEvents(current.inheritedEventCount), options)
  const totals = countsFor([])
  const live = ctx.get('sessions')?.list() ?? [current]
  const known = new Set(live.map(session => String(session.id)))
  if (!known.has(String(current.id))) { live.push(current); known.add(String(current.id)) }
  const cutoff = options.since ? Date.now() - options.since.milliseconds : undefined
  let sessions = 0
  let unreadable = 0
  function add(events: readonly SessionEvent[], createdAt: number): void {
    const counts = countsFor(events, cutoff)
    if (cutoff !== undefined && createdAt < cutoff && !counts.activity) return
    sessions++
    mergeCounts(totals, counts)
  }
  for (const session of live) add(session.snapshotEvents(session.inheritedEventCount), session.header.createdAt)
  const persistence = ctx.get('sessionPersistence')
  let historyAvailable = Boolean(persistence)
  if (persistence) {
    let stored: Awaited<ReturnType<typeof persistence.list>> = []
    try {
      stored = (await persistence.list({ signal })).filter(item => !known.has(String(item.header.id)))
    } catch {
      signal.throwIfAborted()
      historyAvailable = false
    }
    let cursor = 0
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, stored.length) }, async () => {
      for (;;) {
        const item = stored[cursor++]
        if (!item) return
        signal.throwIfAborted()
        let handle
        try {
          handle = await persistence.open(item.header.id, 'read', { signal })
          const result = await handle.read(handle.inheritedEventCount, undefined, { signal })
          add(result.events, item.header.createdAt)
        } catch {
          signal.throwIfAborted()
          unreadable++
        } finally {
          try { await handle?.close() } catch { unreadable++ }
        }
      }
    }))
    signal.throwIfAborted()
    unreadable += workers.filter(result => result.status === 'rejected').length
  }
  if (options.share) return `${sharedReport(totals)}${!historyAvailable || unreadable ? ' History incomplete.' : ''}`
  const lines = [`DSH usage across sessions${options.since ? ` (last ${options.since.label})` : ''}`, `Sessions counted: ${sessions}`]
  if (!historyAvailable) lines.push('History unavailable; showing live sessions only.')
  if (unreadable) lines.push(`Stored session read or close errors: ${unreadable} (totals may be incomplete)`)
  return [...lines, ...linesFor(totals)].join('\n')
}
