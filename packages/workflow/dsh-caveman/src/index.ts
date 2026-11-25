import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createSkillProvider } from './skills.js'
import { defaultModeFor, getReinforce, SessionModeTracker, type DefaultMode, type VoiceMode } from './mode.js'
import { registerCompression } from './compression.js'
import { registerBlocks } from './blocks.js'
import { statsReport } from './stats.js'
import { findCavemanBinary, guardedRuntimeFetch, runtimeSettings, verifiedRuntime } from './runtime.js'
import { registerMemoryRecovery } from './memory.js'
import { registerAttribution } from './attribution.js'
import { isCavecrewPreset, registerNative } from './native.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-caveman-mode': { kind: 'dsh-caveman-mode'; form: 'instructions'; mode: VoiceMode }
    'dsh-caveman-stats': { kind: 'dsh-caveman-stats'; form: 'notice' }
  }
}

export const name = 'caveman'
export const inject = ['skills', 'tools', 'systemPrompt', 'llm']
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787'

export interface Config {
  defaultMode?: DefaultMode
  inputCompression?: boolean
  middlewareEndpoint?: string
  blocksBinary?: string
  browseBinary?: string
  mcpBinary?: string
  memoryBinary?: string
  codeMode?: false | { config: string; workspace: string }
}
export const Config: z<Config> = z.object({
  defaultMode: z.union([
    z.const('caveman'), z.const('ultracave'), z.const('megacave'), z.const('off'), z.const('manual'),
  ]),
  inputCompression: z.boolean(),
  middlewareEndpoint: z.string().default(DEFAULT_ENDPOINT),
  blocksBinary: z.string().min(1),
  browseBinary: z.string().min(1),
  mcpBinary: z.string().min(1),
  memoryBinary: z.string().min(1),
  codeMode: z.union([z.const(false), z.object({ config: z.string().required(), workspace: z.string().required() })]).default(false),
})

export function apply(ctx: Context, config: Config = {}): void {
  const root = fileURLToPath(new URL('../vendor/caveman/skills/', import.meta.url))
  const modes = new SessionModeTracker()
  const settings = runtimeSettings()
  const endpoint = config.middlewareEndpoint ?? DEFAULT_ENDPOINT
  registerAttribution(ctx, endpoint)
  registerNative(ctx, endpoint, { mode: settings.nativeMode, profile: settings.nativeProfile, core: settings.core })
  if (settings.core) {
    let core = readFileSync(new URL('../vendor/caveman/skills/native/native-core.md', import.meta.url), 'utf8').trim()
    if (settings.coreLeanBuild) {
      const lean = readFileSync(new URL('../vendor/caveman/skills/lean-build/SKILL.md', import.meta.url), 'utf8')
        .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim()
      core += ` ${lean}`
    }
    ctx.systemPrompt.section({
      name: 'caveman:core', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 10, interpolate: false,
      text: context => {
        const preset = context.agent && ctx.get('agentPresets')?.composedPreset(context.agent.ctx)
        return isCavecrewPreset(preset) ? '' : core
      },
    })
  }
  ctx.skills.registerProvider(control => createSkillProvider(root, control))
  if (config.inputCompression !== false && settings.input) {
    const automatic = config.inputCompression === true ? undefined : {
      fetch: guardedRuntimeFetch(endpoint), available: (signal: AbortSignal) => verifiedRuntime(endpoint, process.env, signal),
    }
    registerCompression(ctx, endpoint, automatic)
  }
  const blocks = settings.scripts ? findCavemanBinary('blocks', config.blocksBinary) : undefined
  if (blocks) registerBlocks(ctx, blocks)
  const browse = settings.browse ? findCavemanBinary('browse', config.browseBinary) : undefined
  const mcp = settings.mcp ? findCavemanBinary('mcp', config.mcpBinary) : undefined
  const memory = settings.mcp && settings.memory ? findCavemanBinary('memory', config.memoryBinary) : undefined
  if (memory) ctx.inject(['subprocess', 'workingDirectory'], scoped => registerMemoryRecovery(scoped, memory))
  const servers = [{ name: 'caveman', binary: mcp, args: [] }, { name: 'caveman_browse', binary: browse, args: [] }, { name: 'cavemem', binary: memory, args: ['mcp'] }]
    .filter((server): server is { name: string; binary: string; args: string[] } => server.binary !== undefined)
  if (settings.mcp && config.codeMode) {
    if (!mcp) throw new Error('dsh-caveman: Code-Mode requires the Caveman 4.2.0 or newer MCP binary')
    const { config: serversFile, workspace } = config.codeMode
    if (!isAbsolute(serversFile) || !statSync(serversFile, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('dsh-caveman: codeMode.config must be an absolute path to an MCP configuration file')
    }
    if (!isAbsolute(workspace) || !statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('dsh-caveman: codeMode.workspace must be an absolute path to a directory')
    }
    servers.push({ name: 'caveman_codemode', binary: mcp, args: ['codemode', '--config', serversFile, '--workspace', workspace] })
  }
  if (servers.length) {
    ctx.inject(['mcpManager'], scoped => {
      for (const server of servers) {
        if (!scoped.mcpManager.list().some(entry => entry.name === server.name && entry.configured)) {
          scoped.mcpManager.register(server.name, { transport: 'stdio', command: server.binary, args: server.args })
        }
      }
    })
  }
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)
    if (isCavecrewPreset(preset)) return decision
    const directMessages = decision.messages.filter(message => message.source.kind === 'user')
    if (directMessages.length === 0) return decision
    signal.throwIfAborted()
    const statsRequest = directMessages.map(message => {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      return /^\/caveman(?::caveman)?-stats(?:\s+(.*))?$/u.exec(text.trim())
    }).reverse().find(match => match !== null)
    if (statsRequest) {
      const report = await statsReport(ctx, agent.session, statsRequest[1]?.trim() ?? '', signal)
      const reminder = createUserMessage({
        source: { kind: 'dsh-caveman-stats', form: 'notice' },
        content: [{ type: 'text', text: `Print this report verbatim in a fenced code block. Do not infer savings.\n\n${report}` }],
      })
      return { ...decision, messages: [...decision.messages, reminder] }
    }
    const directory = ctx.get('workingDirectory')
    const cwd = directory ? await directory.ensure(agent, signal) : agent.session.header.cwd
    const selected = modes.resolve(defaultModeFor(config.defaultMode, cwd), agent.session, directMessages)
    if (selected.action === 'one-shot' || (selected.mode === 'off' && selected.action === 'none')) return decision
    if (selected.action === 'none' && selected.hasRules && !getReinforce(cwd)) return decision
    let text: string
    if (selected.action === 'status') {
      text = `Report this status without changing it: Caveman mode: ${selected.mode}`
    } else if (selected.action === 'unresolved') {
      text = 'The requested Caveman mode is not recognized. Keep the current mode unchanged and explain the valid commands.'
    } else if (selected.mode === 'off') {
      text = 'Caveman mode is off. Stop following previous Caveman mode instructions and resume the normal response style.'
    } else {
      const skill = await ctx.skills.get(selected.mode, { scope: agent, signal })
      signal.throwIfAborted()
      if (!skill) throw new Error(`dsh-caveman: ${selected.mode} skill is unavailable`)
      text = `Caveman mode: ${selected.mode}\n\n${skill.content}`
    }
    const reminder = createUserMessage({
      source: { kind: 'dsh-caveman-mode', form: 'instructions', mode: selected.mode },
      content: [{ type: 'text', text }],
    })
    return { ...decision, messages: [...decision.messages, reminder] }
  })
}
