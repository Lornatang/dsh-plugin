import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { SessionModeTracker, resolveMode } from '../lib/mode.js'
import { createSkillProvider } from '../lib/skills.js'
import { CompressionHistoryIndex } from '../lib/compression.js'

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const events = Array.from({ length: 1000 }, (_, index) => ({
  type: 'user/message', data: {
    source: { kind: 'user' },
    content: [{ type: 'text', text: index % 150 === 0 ? '/caveman ultra' : 'Inspect the current code and report the results.' }],
  },
}))
const session = {
  get seq() { return events.length },
  snapshotEvents(from = 0, to = events.length) { return events.slice(from, to) },
}
const pending = [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }]
const tracker = new SessionModeTracker()
tracker.resolve('manual', session, pending)
const full = []
const incremental = []
for (let index = 0; index < 101; index++) {
  events.push({ type: 'turn/start', data: {} })
  let start = performance.now()
  const expected = resolveMode('manual', events, pending)
  full.push(performance.now() - start)
  start = performance.now()
  const actual = tracker.resolve('manual', session, pending)
  incremental.push(performance.now() - start)
  if (actual.mode !== expected.mode || actual.action !== expected.action) throw new Error('mode results differ')
}
const provider = createSkillProvider(resolve('vendor/caveman/skills'))
const discovery = []
for (let index = 0; index < 31; index++) {
  const start = performance.now()
  const result = await provider.list({})
  if (!result.complete || result.candidates.length !== 22) throw new Error('skill catalog is incomplete')
  discovery.push(performance.now() - start)
}
const historyEvents = Array.from({ length: 5000 }, (_, index) => index % 2 === 0
  ? { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: `call-${index}`, name: 'read' }] } } }
  : { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ordinary result' }] } } })
const historySession = {
  get seq() { return historyEvents.length },
  snapshotEvents(from = 0, to = historyEvents.length) { return historyEvents.slice(from, to) },
  eventAt() { return undefined },
}
const history = new CompressionHistoryIndex()
history.read(historySession)
const fullHistory = []
const incrementalHistory = []
for (let index = 0; index < 101; index++) {
  historyEvents.push({ type: 'turn/start', data: {} })
  let start = performance.now()
  const hasMarker = historySession.snapshotEvents().some(event => event.type === 'tool/result' &&
    event.data.message.content.some(block => block.type === 'text' && block.text.includes('[caveman: shortened; exact original via caveman_retrieve handle=')))
  const names = new Map()
  for (const event of historySession.snapshotEvents()) {
    if (event.type === 'assistant/message') for (const block of event.data.message.content) {
      if (block.type === 'tool-call' && !names.has(block.id)) names.set(block.id, block.name)
    }
  }
  fullHistory.push(performance.now() - start)
  start = performance.now()
  const actual = history.read(historySession)
  history.read(historySession)
  incrementalHistory.push(performance.now() - start)
  if (actual.hasMarker !== hasMarker || actual.toolNames.size !== names.size) throw new Error('compression history differs')
}
console.log(JSON.stringify({
  mode: { initialMessages: 1000, runs: full.length, fullReplayMedianMs: median(full), incrementalMedianMs: median(incremental) },
  skills: { count: 22, runs: discovery.length, discoveryMedianMs: median(discovery) },
  compressionHistory: { initialEvents: 5000, runs: fullHistory.length, fullScanMedianMs: median(fullHistory), incrementalMedianMs: median(incrementalHistory) },
}, null, 2))
