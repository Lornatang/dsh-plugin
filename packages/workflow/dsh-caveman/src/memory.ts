import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Expose the exact-original operation that the memory server's MCP tools omit. */
export function registerMemoryRecovery(ctx: Context, binary: string): void {
  if (ctx.tools.get('cavemem_recover')) return
  const tool: ToolDefinition = {
    name: 'cavemem_recover',
    description: 'Read the exact original for a recovery_handle returned by cavemem_recall. The handle has the form ccr_ followed by 32 lowercase hexadecimal characters.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['handle'],
      properties: { handle: { type: 'string' } },
    },
    timeoutMs: 15_000,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(value, exec) {
      const handle = typeof value === 'object' && value !== null && 'handle' in value ? value.handle : undefined
      if (typeof handle !== 'string' || !/^ccr_[a-f0-9]{32}$/u.test(handle)) throw new Error('Invalid memory recovery handle')
      const cwd = exec.agent ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : process.cwd()
      const executable = await ctx.subprocess.resolveExecutable(binary, {}, exec.signal)
      const child = ctx.subprocess.spawn({
        argv: [executable, 'recover', handle], cwd, signal: exec.signal, graceMs: 1000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 262_144 }, stderr: { maxBytes: 4096 } },
      })
      const outcome = await child.done
      exec.signal.throwIfAborted()
      const stdout = child.collected.stdout?.readFrom(0)
      const stderr = child.collected.stderr?.readFrom(0)
      if (!stdout || !stderr || outcome.signal || outcome.exitCode !== 0 || stdout.lossy) {
        throw new Error(`Memory recovery failed: ${stderr?.text.slice(0, 1024) || 'original unavailable'}`)
      }
      return stdout.text
    },
  }
  ctx.tools.register(tool)
}
