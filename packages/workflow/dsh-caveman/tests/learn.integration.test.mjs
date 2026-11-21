import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

const binary = process.env.DSH_CAVEMAN_LEARN_BINARY
const run = promisify(execFile)

test('learn reads real compressed DSH session usage', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-learn-'))
  const sessions = join(directory, 'sessions')
  const caveHome = join(directory, 'caveman')
  const prompt = 'The fixture requires checking the recorded evidence before applying any change. '.repeat(30).trim()
  await mkdir(caveHome)
  const ctx = new Context()
  let disposed = false
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: sessions })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(defineTool({
      name: 'fixture_log', description: 'Read fixture output.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return Array.from({ length: 80 }, (_, i) => `2026-07-28T12:00:${String(i % 60).padStart(2, '0')}Z INFO fixture worker=${i} processed batch ok\n`).join('') },
    }))
    class Adapter extends LlmAdapter {
      count = 0
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream() {
        const first = this.count++ === 0
        if (first) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: 'fixture-log-call', name: 'fixture_log', argumentsDelta: '{}' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-log-call', name: 'fixture_log', arguments: '{}' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'ok' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
        }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 4 } }
        yield { type: 'finish', reason: { kind: first ? 'tool-calls' : 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Adapter())
    const handle = await ctx.agents.create({ sessionId: 'learn-fixture', meta: { cwd: directory }, agentOptions: { provider: 'fixture', model: 'model' } })
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }))
    await handle.agent.whenIdle()
    await handle.dispose()
    const storedPath = (await ctx.sessionPersistence.stat('learn-fixture')).location.path
    for (const id of ['learn-fixture-two', 'learn-fixture-three']) {
      const other = await ctx.agents.create({ sessionId: id, meta: { cwd: directory }, agentOptions: { provider: 'fixture', model: 'model' } })
      other.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }))
      await other.agent.whenIdle()
      await other.dispose()
    }
    await ctx.fiber.dispose()
    disposed = true
    const result = await run(binary, ['learn', 'report', '--sources', 'dsh', '--json', '--retro'], {
      cwd: directory, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CAVEMAN_HOME: caveHome, CAVEMAN_DSH_SESSION_ROOT: sessions },
    })
    const plan = JSON.parse(result.stdout)
    assert.equal(plan.schema, 'caveman.learn.v1')
    assert.equal(plan.sessions_by_source.dsh, 3)
    assert.equal(plan.sessions_scanned, 3)
    assert.equal(plan.spend.unpriced[0].tokens, 156, 'the four disjoint token buckets are counted exactly once per response')
    assert.match(plan.cave_score.components.find(component => component.key === 'dumbzone').detail, /4 messages/u)
    assert.equal(plan.retro.turns_observed, 4, 'the retrospective pass includes DSH usage')
    assert.ok(plan.retro.families.some(family => family.id === 'tool_outputs' && family.tokens > 0), 'real DSH tool output reaches the compression engine')
    const recurring = plan.sinks.find(sink => sink.sink_id.startsWith('recurring_context:repaste:'))
    assert.ok(recurring, 'repeated human context is identified across DSH sessions')
    const candidateResult = await run(binary, ['learn', 'apply', recurring.sink_id, '--dry-run', '--sources', 'dsh'], {
      cwd: directory, windowsHide: true, env: { ...process.env, CAVEMAN_HOME: caveHome, CAVEMAN_DSH_SESSION_ROOT: sessions },
    })
    const candidate = JSON.parse(candidateResult.stdout).candidate
    assert.equal(candidate.fix_kind, 'cavemem_offload')
    assert.ok(!candidateResult.stdout.includes(prompt), 'the candidate contains locators but not raw session content')
    const reportedLocator = candidate.what_to_offload.locators.find(item => item.root_kind === 'dsh')
    assert.ok(reportedLocator)
    const rows = zstdDecompressSync(await readFile(storedPath)).toString('utf8').trimEnd().split('\n')
    const line = rows.findIndex(row => { const event = JSON.parse(row); return event.type === 'user/message' && event.data?.source?.kind === 'user' }) + 1
    assert.ok(line > 1)
    const digest = createHash('sha256').update(prompt).digest('hex')
    const locator = await run(binary, ['learn', 'locate', '--path', relative(sessions, storedPath), '--line', String(line), '--block', '0', '--sha256', digest], {
      cwd: directory, windowsHide: true, env: { ...process.env, CAVEMAN_HOME: caveHome, CAVEMAN_DSH_SESSION_ROOT: sessions },
    })
    assert.equal(locator.stdout, prompt, 'a locator recovers the exact verified human block')
    const wrapper = fileURLToPath(new URL('../scripts/caveman-cli.mjs', import.meta.url))
    const wrapperEnv = { ...process.env, CAVEMAN_HOME: caveHome, CAVEMAN_DSH_SESSION_ROOT: sessions,
      DSH_CAVEMAN_LEARN_BINARY: binary, CAVEMAN_PROXY_BIN: join(directory, 'not-the-learn-binary') }
    const viaWrapper = await run(process.execPath, [wrapper, 'learn', 'report', '--sources', 'dsh', '--json'], {
      cwd: directory, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env: wrapperEnv,
    })
    assert.equal(JSON.parse(viaWrapper.stdout).sessions_by_source.dsh, 3, 'the package command uses the DSH-aware analyzer')
    const wrappedLocator = await run(process.execPath, [wrapper, 'learn', 'locate', '--path', relative(sessions, storedPath), '--line', String(line), '--block', '0', '--sha256', digest], {
      cwd: directory, windowsHide: true, env: wrapperEnv,
    })
    assert.equal(wrappedLocator.stdout, prompt, 'the package command preserves exact locator bytes')
    const reported = await run(process.execPath, [wrapper, 'learn', 'locate', '--path', reportedLocator.rel_path,
      '--line', String(reportedLocator.jsonl_line), '--block', String(reportedLocator.block_index), '--sha256', reportedLocator.content_sha256], {
      cwd: directory, windowsHide: true, env: wrapperEnv,
    })
    assert.equal(reported.stdout, prompt, 'the candidate locator resolves to the exact source block')
  } finally {
    if (!disposed) await ctx.fiber.dispose()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-learn-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
