import type { Context } from '@deepseek-ai/cordis'
import { NotionBridge } from './bridge.js'
import { Config, type Config as Settings } from './config.js'
import { registerRoutes, type RouteRegistrar } from './routes.js'
import { SessionStore, sessionFileFor } from './store.js'

export const name = 'notion'
export const inject = ['tools']
export { Config }

interface Scope {
  get(name: string): unknown
  profileContext?: { patchPath?: string }
  on?(event: string, callback: (name?: string) => void): (() => void) | undefined
}

export function apply(ctx: Context, config: Settings): void {
  const scope = ctx as unknown as Scope
  const store = new SessionStore(sessionFileFor(config.serverName, config.url, scope.profileContext?.patchPath))
  const host = { register: (definition: Parameters<typeof ctx.tools.register>[0]) => ctx.tools.register(definition), logger: ctx.logger }
  const bridge = new NotionBridge(host, { ...config, store })
  ctx.effect(() => () => bridge.dispose(), 'notion:connection')
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    let boundWeb: unknown
    const bind = (): void => {
      const web = scope.get('webServer') as RouteRegistrar | undefined
      const webIdentity: unknown = web && (Reflect.get(web, Symbol.for('cordis.original')) ?? web)
      if (webIdentity === boundWeb) return
      dispose?.()
      boundWeb = webIdentity
      dispose = web ? registerRoutes(web, bridge) : undefined
    }
    bind()
    const off = scope.on?.('internal/service', (name) => {
      if (!name || name === 'webServer') bind()
    })
    return () => { off?.(); dispose?.() }
  }, 'notion:routes')
  void bridge.start().catch((error: unknown) => ctx.logger.error(`notion: ${String(error)}`))
}
