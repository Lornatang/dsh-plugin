import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { GithubBridge } from './bridge.js'
import { Config, type Config as Settings } from './config.js'
import { registerRoutes, type RequestFence, type RouteRegistrar } from './routes.js'
import { SessionStore, sessionFileFor } from './store.js'

export const name = 'github'
export const inject = ['tools']
export { Config }

interface Scope {
  get(name: string): unknown
  profileContext?: { patchPath?: string }
  on?(event: string, callback: (...args: any[]) => unknown): (() => void) | undefined
}

function identity(value: unknown): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value
  return (value as Record<symbol, unknown>)[Symbol.for('cordis.original')] ?? value
}

export function apply(ctx: Context, config: Settings): void {
  const scope = ctx as unknown as Scope
  const store = new SessionStore(sessionFileFor(config.serverName, config.url, scope.profileContext?.patchPath))
  // Fail closed when the host cannot ask for approval: tools that may modify
  // remote data must not register without an approval hook.
  const approvalHook = typeof scope.on === 'function'
  if (!approvalHook) ctx.logger.error('github: tool approval hook is unavailable; only read-only tools will register')
  const bridge = new GithubBridge({ register: (definition) => ctx.tools.register(definition), logger: ctx.logger }, { ...config, store, approvalHook })
  ctx.effect(() => () => bridge.dispose(), 'github:connection')
  ctx.effect(() => {
    const off = scope.on?.('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
      const decision = await next()
      if (decision.kind !== 'allow' || !bridge.requiresApproval(exec.name)) return decision
      return { kind: 'ask', reason: `GitHub operation ${exec.name} may modify remote data` }
    })
    return () => off?.()
  }, 'github:approval')
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    let boundWeb: unknown
    let boundFence: unknown
    const bind = (): void => {
      const web = (scope.get('webServer') ?? scope.get('httpServer')) as RouteRegistrar | undefined
      const fence = scope.get('connection') as RequestFence | undefined
      if (dispose && identity(web) === boundWeb && identity(fence) === boundFence) return
      dispose?.(); dispose = undefined
      boundWeb = identity(web); boundFence = identity(fence)
      if (web) dispose = registerRoutes(web, bridge, fence)
    }
    bind()
    const off = scope.on?.('internal/service', (name?: string) => {
      if (!name || name === 'connection' || name === 'webServer' || name === 'httpServer') bind()
    })
    return () => { off?.(); dispose?.() }
  }, 'github:routes')
  void bridge.start().catch((error: unknown) => ctx.logger.error(`github: ${error instanceof Error ? error.message : 'startup failed'}`))
}
