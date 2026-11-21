import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-working-directory'

type ReadOnlyRole = 'investigator' | 'reviewer'
type GitInput = { operation: 'grep' | 'log' | 'diff' | 'show'; query?: string; revision?: string; path?: string }

function gitArguments(role: ReadOnlyRole, args: GitInput): string[] {
  const supported = role === 'investigator' ? ['grep', 'log'] : ['diff', 'log', 'show']
  if (!supported.includes(args.operation)) throw new Error(`Cavecrew ${role} cannot run this Git operation`)
  if (args.revision !== undefined && (!/^[a-zA-Z0-9_@/.~^:+{}-]{1,256}$/u.test(args.revision) || args.revision.startsWith('-'))) {
    throw new Error('Invalid Git revision')
  }
  if (args.path !== undefined && (!args.path || args.path.length > 4096 || args.path.includes('\0'))) throw new Error('Invalid Git path')
  if (args.query !== undefined && (!args.query || args.query.length > 1024 || args.query.includes('\0'))) throw new Error('Invalid Git query')
  const path = args.path === undefined ? [] : [args.path]
  if (args.operation === 'grep') {
    if (!args.query) throw new Error('Git grep requires a query')
    return ['grep', '--line-number', '--no-color', '-e', args.query, '--', ...path]
  }
  if (args.operation === 'log' && role === 'investigator') {
    if (!args.query) throw new Error('Investigator Git log requires a query')
    return ['log', '--no-color', '--no-show-signature', '--max-count=20', '--oneline', `-S${args.query}`, ...(args.revision ? [args.revision] : []), '--', ...path]
  }
  const shared = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-show-signature']
  if (args.operation === 'log') return ['log', ...shared, '--max-count=20', '-p', ...(args.revision ? [args.revision] : []), '--', ...path]
  if (args.operation === 'diff') return ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(args.revision ? [args.revision] : []), '--', ...path]
  return ['show', ...shared, args.revision ?? 'HEAD', '--', ...path]
}

/** Provide the read-only Git operations used by the two inspection roles. */
export function registerCavecrewGit(ctx: Context, role: ReadOnlyRole): void {
  const operations = role === 'investigator' ? ['grep', 'log'] : ['diff', 'log', 'show']
  const tool: ToolDefinition = {
    name: 'cavecrew_git',
    description: `Read repository history and changes without shell execution. Use instead of Bash for Git ${operations.join(', ')}.`,
    parameters: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: operations },
        query: { type: 'string', description: 'Search expression for grep or text to locate in investigator history.' },
        revision: { type: 'string', description: 'Git revision or revision range.' },
        path: { type: 'string', description: 'Optional file or directory path.' },
      },
    },
    timeoutMs: 15_000,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(value, exec) {
      if (!exec.agent) throw new Error('Cavecrew Git requires an agent session')
      const args = value as GitInput
      const command = gitArguments(role, args)
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const platform = (await ctx.subprocess.terminalEnvironment(exec.signal)).platform
      const nullDevice = platform === 'windows' ? 'NUL' : '/dev/null'
      const env: NodeJS.ProcessEnv = {
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullDevice, GIT_CONFIG_GLOBAL: nullDevice,
        GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: undefined, GIT_DIR: undefined, GIT_COMMON_DIR: undefined,
        GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_EXTERNAL_DIFF: undefined, GIT_OPTIONAL_LOCKS: '0',
        GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat',
      }
      const binary = await ctx.subprocess.resolveExecutable('git', {}, exec.signal)
      const child = ctx.subprocess.spawn({
        argv: [binary, '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...command],
        cwd, env, signal: exec.signal, graceMs: 1000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 262_144 }, stderr: { maxBytes: 4096 } },
      })
      const outcome = await child.done
      exec.signal.throwIfAborted()
      const stdout = child.collected.stdout?.readFrom(0)
      const stderr = child.collected.stderr?.readFrom(0)
      if (!stdout || !stderr || outcome.signal || outcome.exitCode === null) throw new Error('Git did not complete')
      if (outcome.exitCode !== 0 && !(args.operation === 'grep' && outcome.exitCode === 1)) {
        throw new Error(`Git ${args.operation} failed (exit ${outcome.exitCode}): ${stderr.text.slice(0, 1024)}`)
      }
      if (args.operation === 'grep' && outcome.exitCode === 1) return 'No matches.'
      return `${stdout.lossy ? '[Earlier output truncated]\n' : ''}${stdout.text}`
    },
  }
  ctx.tools.register(tool)
}
