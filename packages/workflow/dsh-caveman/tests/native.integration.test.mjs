import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import McpManager from '@deepseek-ai/dsh-mcp-manager'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { verifiedRuntime } from '../lib/runtime.js'
import { cavemanSessionId } from '../lib/attribution.js'
import { nativeSocketPath } from '../lib/native.js'
import * as plugin from '../lib/index.js'

const binary = process.env.CAVEMAN_PROXY_BINARY
const mcpBinary = process.env.CAVEMAN_MCP_BINARY

test('the local native runtime contributes a task contract to a DSH session', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-native-'))
  const previous = process.env.CAVEMAN_HOME
  const probe = createServer()
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).on('error', reject))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const endpoint = `http://127.0.0.1:${port}`
  const child = spawn(binary, ['serve'], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, CAVEMAN_HOME: directory, CAVEMAN_CONFIG: join(directory, 'missing.yaml'),
    CAVEMAN_LISTEN: `127.0.0.1:${port}`, CAVEMAN_MODE: 'compress', CAVEMAN_PROXY_OWNER: 'start',
  } })
  const ctx = new Context()
  try {
    process.env.CAVEMAN_HOME = directory
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await verifiedRuntime(endpoint, process.env)) break
      if (child.exitCode !== null || attempt === 99) throw new Error('native runtime did not start')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const connected = await new Promise(resolve => {
        const socket = connect({ path: nativeSocketPath(directory) })
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false))
      })
      if (connected) break
      if (attempt === 99) throw new Error('native socket did not start')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalFileSystem, { cwd: directory })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(WorkingDirectory, { defaultDirectory: directory })
    await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions') })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, { default: 'fixture' })
    await ctx.plugin(SkillRegistry)
    if (mcpBinary) await ctx.plugin(McpManager, {})
    await ctx.plugin(plugin, { defaultMode: 'manual', inputCompression: false, middlewareEndpoint: endpoint, ...(mcpBinary ? { mcpBinary } : {}) })
    class Adapter extends LlmAdapter {
      requests = []
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream(options) { this.requests.push(options); yield { type: 'finish', reason: { kind: 'stop' } } }
    }
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create('native-session', { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the regression in login.' }] }))
    await agent.whenIdle()
    const text = JSON.stringify(adapter.requests[0].messages)
    assert.match(text, /Caveman task contract \(dynamic tail\): type=bugfix/u)
    assert.match(text, /Fix the regression in login\./u, 'the user prompt remains present')
    agent.session.append('compaction/start', { compactionId: 'fixture-compact', turn: null })
    agent.session.append('compaction/end', { compactionId: 'fixture-compact', turn: null })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] }))
    await agent.whenIdle()
    assert.match(JSON.stringify(adapter.requests.at(-1).messages), /Caveman compact state \(dynamic tail\)/u)
    const closing = await ctx.agents.create({ sessionId: 'native-finish-session', agentOptions: { provider: 'mock', model: 'mock' } })
    closing.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the result.' }] }))
    await closing.agent.whenIdle()
    await closing.dispose()
    let receipt
    for (let attempt = 0; attempt < 100; attempt++) {
      try { receipt = JSON.parse(await readFile(join(directory, 'receipts', 'latest.json'), 'utf8')); break } catch {}
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(receipt?.session_id, cavemanSessionId('native-finish-session'), 'session disposal closes the native session and writes its receipt')
    if (mcpBinary) {
      for (let attempt = 0; attempt < 600; attempt++) {
        const state = ctx.mcpManager.list().find(entry => entry.name === 'caveman')?.status
        if (state?.state === 'connected') break
        if (state?.state === 'failed' || attempt === 599) throw new Error(`Caveman MCP did not connect: ${JSON.stringify(state)}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const path = join(directory, 'sample.txt')
      await writeFile(path, 'sample file contents')
      const runFile = join(directory, 'run', `${port}.json`)
      let savedRunState
      ctx.tools.register(defineTool({
        name: 'read', description: 'Read the fixture.', parameters: { path: { type: 'string', required: true }, offset: { type: 'integer' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(_args, execution) {
          if (String(execution.agent?.session.id) === 'native-tamper-session' && !savedRunState) {
            savedRunState = await readFile(runFile, 'utf8')
            await writeFile(runFile, JSON.stringify({ ...JSON.parse(savedRunState), instance_token: 'different-listener' }))
          }
          return readFile(path, 'utf8')
        },
      }))
      await ctx.plugin(SubagentRuntime, {})
      await ctx.plugin(Spawn, { providerName: 'spawn' })
      await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'delegate_fixture' })
      class ChildAdapter extends LlmAdapter {
        count = 0
        requests = []
        async resolveModel(provider, model) { return { provider, id: model, name: model } }
        async *stream(options) {
          this.requests.push(options)
          if (this.count++ > 0) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
          const args = JSON.stringify({ path })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: 'child-read', name: 'read', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'child-read', name: 'read', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        }
      }
      ctx.llm.registerAdapter(['child-mock'], new ChildAdapter())
      const parent = await ctx.agentLoop.create('native-parent-session', { provider: 'child-mock', model: 'mock' }, { cwd: directory })
      let childId
      const ended = new Promise(resolve => ctx.on('subagent/end', info => { childId = info.id; resolve() }))
      const activation = await ctx.tools.execute({ agent: parent, signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: 'native-delegate', name: 'delegate_fixture', arguments: JSON.stringify({ description: 'Inspect', prompt: 'Inspect the file.' }) }] })
      assert.equal(activation.results[0].result.isError, false, JSON.stringify(activation.results[0].result))
      await ended
      const database = new DatabaseSync(join(directory, 'ccr.db'), { readOnly: true })
      try {
        const parentId = cavemanSessionId('native-parent-session')
        let merge
        for (let attempt = 0; attempt < 100; attempt++) {
          merge = database.prepare('SELECT data FROM typed_objects WHERE session_id = ? AND source = ?').get(parentId, 'native:subagent-merge')
          if (merge) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        if (!merge) {
          const rows = database.prepare('SELECT session_id, source, object_type, lifecycle FROM typed_objects WHERE session_id IN (?, ?) ORDER BY created_at')
            .all(parentId, cavemanSessionId(String(childId)))
          assert.fail(`the child contributes its native observations to its direct parent; native records=${JSON.stringify(rows)}`)
        }
        const body = JSON.parse(Buffer.from(merge.data).toString('utf8'))
        assert.equal(body.child_session_id, cavemanSessionId(String(childId)))
        assert.equal(body.parent_session_id, parentId)
        const observation = body.evidence.find(item => item.type === 'FileObservation')
        assert.ok(observation, 'the merge retains the child file observation')
        const recovered = await ctx.tools.execute({ agent: parent, signal: new AbortController().signal,
          calls: [{ type: 'tool-call', id: 'child-observation', name: 'mcp__caveman__caveman_retrieve', arguments: JSON.stringify({ recovery_handle: observation.reference }) }] })
        assert.equal(recovered.results[0].result.content[0].text, 'sample file contents', 'the merged observation remains recoverable after the child ends')
      } finally { database.close() }
      await ctx.plugin(AgentPreset, { id: 'cavecrew-investigator', plugins: [] })
      await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'delegate_special', agentPreset: 'cavecrew-investigator' })
      const specialAdapter = new ChildAdapter()
      ctx.llm.registerAdapter(['special-mock'], specialAdapter)
      const specialParent = await ctx.agentLoop.create('native-special-parent', { provider: 'special-mock', model: 'mock' }, { cwd: directory })
      let specialId
      const specialEnded = new Promise(resolve => ctx.on('subagent/end', info => { if (info.parentSessionId === specialParent.id) { specialId = info.id; resolve() } }))
      const specialActivation = await ctx.tools.execute({ agent: specialParent, signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: 'native-special-delegate', name: 'delegate_special', arguments: JSON.stringify({ description: 'Inspect', prompt: 'Inspect the file.' }) }] })
      assert.equal(specialActivation.results[0].result.isError, false, JSON.stringify(specialActivation.results[0].result))
      await specialEnded
      assert.doesNotMatch(JSON.stringify(specialAdapter.requests), /Caveman task contract \(dynamic tail\)/u, 'a specialized persona keeps its own policy')
      const specialDatabase = new DatabaseSync(join(directory, 'ccr.db'), { readOnly: true })
      try {
        let merge
        for (let attempt = 0; attempt < 100; attempt++) {
          merge = specialDatabase.prepare('SELECT data FROM typed_objects WHERE session_id = ? AND source = ?').get(cavemanSessionId('native-special-parent'), 'native:subagent-merge')
          if (merge) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        if (!merge) {
          const rows = specialDatabase.prepare('SELECT session_id, source, object_type, lifecycle FROM typed_objects WHERE session_id IN (?, ?) ORDER BY created_at')
            .all(cavemanSessionId('native-special-parent'), cavemanSessionId(String(specialId)))
          assert.fail(`specialized children also contribute their observations; requests=${specialAdapter.requests.length}; native records=${JSON.stringify(rows)}`)
        }
        const body = JSON.parse(Buffer.from(merge.data).toString('utf8'))
        assert.equal(body.child_session_id, cavemanSessionId(String(specialId)))
        assert.ok(body.evidence.some(item => item.type === 'FileObservation'))
      } finally { specialDatabase.close() }
      class ReadAdapter extends LlmAdapter {
        requests = []
        constructor(changeFile = false, beforeSecond, changeWindow = false) { super(); this.changeFile = changeFile; this.beforeSecond = beforeSecond; this.changeWindow = changeWindow }
        async resolveModel(provider, model) { return { provider, id: model, name: model } }
        async *stream(options) {
          this.requests.push(options)
          if (this.requests.length > 2) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
          if (this.changeFile && this.requests.length === 2) await writeFile(path, 'updated fixture with a different length')
          if (this.requests.length === 2) await this.beforeSecond?.()
          const id = `read-${this.requests.length}`
          const args = JSON.stringify({ path, ...(this.changeWindow && this.requests.length === 2 ? { offset: 2 } : {}) })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: 'read', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        }
      }
      const reads = new ReadAdapter()
      ctx.llm.registerAdapter(['read-mock'], reads)
      const reader = await ctx.agentLoop.create('native-read-session', { provider: 'read-mock', model: 'mock' }, { cwd: directory })
      reader.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the file.' }] }))
      await reader.whenIdle()
      const final = JSON.stringify(reads.requests.at(-1).messages)
      assert.match(final, /Current observation already exists/u)
      const handle = /ccr:\/\/[a-zA-Z0-9_-]+/u.exec(final)?.[0]
      assert.ok(handle, 'the reuse hint names the stored observation')
      const recovered = await ctx.tools.execute({ signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: 'native-recover', name: 'mcp__caveman__caveman_retrieve', arguments: JSON.stringify({ recovery_handle: handle }) }] })
      assert.equal(recovered.results[0].result.content[0].text, 'sample file contents')
      await writeFile(path, 'sample file contents')
      const changed = new ReadAdapter(true)
      ctx.llm.registerAdapter(['changed-mock'], changed)
      const changingReader = await ctx.agentLoop.create('native-changed-session', { provider: 'changed-mock', model: 'mock' }, { cwd: directory })
      changingReader.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the file.' }] }))
      await changingReader.whenIdle()
      assert.doesNotMatch(JSON.stringify(changed.requests.at(-1).messages), /Current observation already exists/u, 'a changed file is never treated as current')
      const originalContent = 'sample file contents'
      const fixedTime = new Date('2026-01-01T00:00:00.000Z')
      await writeFile(path, originalContent)
      await utimes(path, fixedTime, fixedTime)
      const stale = new ReadAdapter(false, async () => {
        await writeFile(path, originalContent.replaceAll('a', 'z'))
        await utimes(path, fixedTime, fixedTime)
      })
      ctx.llm.registerAdapter(['stale-mock'], stale)
      const staleReader = await ctx.agentLoop.create('native-stale-session', { provider: 'stale-mock', model: 'mock' }, { cwd: directory })
      staleReader.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the file.' }] }))
      await staleReader.whenIdle()
      assert.equal((await stat(path)).size, Buffer.byteLength(originalContent))
      assert.equal((await stat(path)).mtimeMs, fixedTime.getTime())
      assert.doesNotMatch(JSON.stringify(stale.requests.at(-1).messages), /Current observation already exists/u, 'equal size and timestamp cannot make changed bytes current')
      const windows = new ReadAdapter(false, undefined, true)
      ctx.llm.registerAdapter(['window-mock'], windows)
      const windowReader = await ctx.agentLoop.create('native-window-session', { provider: 'window-mock', model: 'mock' }, { cwd: directory })
      windowReader.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the file.' }] }))
      await windowReader.whenIdle()
      assert.doesNotMatch(JSON.stringify(windows.requests.at(-1).messages), /Current observation already exists/u, 'a different read window is not the earlier observation')
      const denied = new ReadAdapter()
      ctx.llm.registerAdapter(['denied-mock'], denied)
      const deniedReader = await ctx.agentLoop.create('native-denied-session', { provider: 'denied-mock', model: 'mock' }, { cwd: directory })
      deniedReader.ctx.get('tools').restrict({ deny: ['mcp__caveman__caveman_retrieve'] })
      deniedReader.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the file.' }] }))
      await deniedReader.whenIdle()
      assert.doesNotMatch(JSON.stringify(denied.requests.at(-1).messages), /Current observation already exists/u, 'a recovery-restricted model gets no unusable handle')
      const tampered = new ReadAdapter(false, async () => { if (savedRunState) await writeFile(runFile, savedRunState) })
      ctx.llm.registerAdapter(['tamper-mock'], tampered)
      const tamperedReader = await ctx.agentLoop.create('native-tamper-session', { provider: 'tamper-mock', model: 'mock' }, { cwd: directory })
      tamperedReader.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the file.' }] }))
      await tamperedReader.whenIdle()
      assert.ok(savedRunState, 'the runtime identity changed during the first tool call')
      assert.doesNotMatch(JSON.stringify(tampered.requests.at(-1).messages), /Current observation already exists/u, 'tool output is not recorded while runtime identity is unverified')
    }
  } finally {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env.CAVEMAN_HOME
    else process.env.CAVEMAN_HOME = previous
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill()
      await exited
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-native-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
