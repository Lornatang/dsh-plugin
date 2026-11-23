import { GithubBridge } from './bridge.js';
import { Config } from './config.js';
import { registerRoutes } from './routes.js';
import { SessionStore, sessionFileFor } from './store.js';
export const name = 'github';
export const inject = ['tools'];
export { Config };
export function apply(ctx, config) {
    const scope = ctx;
    const store = new SessionStore(sessionFileFor(config.serverName, config.url, scope.profileContext?.patchPath));
    // Fail closed when the host cannot ask for approval: tools that may modify
    // remote data must not register without an approval hook.
    const approvalHook = typeof scope.on === 'function';
    if (!approvalHook)
        ctx.logger.error('github: tool approval hook is unavailable; only read-only tools will register');
    const bridge = new GithubBridge({ register: (definition) => ctx.tools.register(definition), logger: ctx.logger }, { ...config, store, approvalHook });
    ctx.effect(() => () => bridge.dispose(), 'github:connection');
    ctx.effect(() => {
        const off = scope.on?.('tools/pre-execute', async (exec, next) => {
            const decision = await next();
            if (decision.kind !== 'allow' || !bridge.requiresApproval(exec.name))
                return decision;
            return { kind: 'ask', reason: `GitHub operation ${exec.name} may modify remote data` };
        });
        return () => off?.();
    }, 'github:approval');
    ctx.effect(() => {
        let dispose;
        let boundWeb;
        const bind = () => {
            const web = scope.get('webServer');
            const webIdentity = web && (Reflect.get(web, Symbol.for('cordis.original')) ?? web);
            if (webIdentity === boundWeb)
                return;
            dispose?.();
            boundWeb = webIdentity;
            dispose = web ? registerRoutes(web, bridge) : undefined;
        };
        bind();
        const off = scope.on?.('internal/service', (name) => {
            if (!name || name === 'webServer')
                bind();
        });
        return () => { off?.(); dispose?.(); };
    }, 'github:routes');
    void bridge.start().catch((error) => ctx.logger.error(`github: ${error instanceof Error ? error.message : 'startup failed'}`));
}
