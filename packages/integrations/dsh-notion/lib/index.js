import { NotionBridge } from './bridge.js';
import { Config } from './config.js';
import { registerRoutes } from './routes.js';
import { SessionStore, sessionFileFor } from './store.js';
export const name = 'notion';
export const inject = ['tools'];
export { Config };
export function apply(ctx, config) {
    const scope = ctx;
    const store = new SessionStore(sessionFileFor(config.serverName, config.url, scope.profileContext?.patchPath));
    const host = { register: (definition) => ctx.tools.register(definition), logger: ctx.logger };
    const bridge = new NotionBridge(host, { ...config, store });
    ctx.effect(() => () => bridge.dispose(), 'notion:connection');
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
    }, 'notion:routes');
    void bridge.start().catch((error) => ctx.logger.error(`notion: ${String(error)}`));
}
