import * as React from 'react'

const h = React.createElement
const prefix = '/plugins/github'
const STATUS_TIMEOUT_MS = 10_000
interface ClientContext { slots: { inject(name: string, callback: () => unknown): () => void; register(options: Record<string, unknown>, component: React.ComponentType<never>): unknown } }
interface Snapshot { ok: boolean; status: 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error'; error?: string; warning?: string; toolCount: number; source?: string; readOnly: boolean; oauthAvailable: boolean; requiredScopes?: string[]; scopes?: string[]; authorization?: { userCode: string; verificationUri: string } }

if (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-github]')) {
  const style = document.createElement('style')
  style.setAttribute('data-dsh-github', '')
  style.textContent = `
.dsg-root{box-sizing:border-box;max-width:820px;margin:auto;padding:24px 28px 36px;font-size:14px;line-height:1.55;color:inherit}
.dsg-root *{box-sizing:border-box}.dsg-root h2,.dsg-root h3,.dsg-root p{margin:0}.dsg-head{display:flex;align-items:center;gap:14px;margin-bottom:24px}
.dsg-logo{display:grid;place-items:center;width:46px;height:46px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:12px;font:700 23px system-ui;background:color-mix(in srgb,currentColor 4%,transparent)}
.dsg-title{font-size:23px;font-weight:700}.dsg-sub{opacity:.68;font-size:13px;margin-top:3px!important}.dsg-label{font-size:11px;letter-spacing:.09em;text-transform:uppercase;opacity:.6;margin-bottom:9px!important;font-weight:700}
.dsg-card{border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:13px;background:color-mix(in srgb,currentColor 2.5%,transparent);padding:18px}
.dsg-status{display:flex;align-items:center;gap:12px}.dsg-dot{width:10px;height:10px;border-radius:50%;background:#e6a23c;flex:none}.dsg-dot.ready{background:#2dbb87}.dsg-dot.error{background:#e15c5c}
.dsg-status-copy{flex:1;min-width:0}.dsg-status-copy strong{display:block}.dsg-count{font-size:12px;opacity:.65;white-space:nowrap}.dsg-note{font-size:13px;opacity:.7;margin-top:14px!important}
.dsg-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px}.dsg-button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:7px 14px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:9px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:600 13px system-ui;text-decoration:none;cursor:pointer}
.dsg-button.primary{background:#4779ed;color:white;border-color:#4779ed}.dsg-button:disabled{opacity:.45;cursor:not-allowed}.dsg-button:focus-visible,.dsg-input:focus-visible{outline:2px solid #7196ff;outline-offset:2px}.dsg-error{margin-top:14px!important;padding:10px 12px;border-radius:9px;background:rgba(230,89,89,.1);color:#e56b6b;overflow-wrap:anywhere}
.dsg-auth{margin-top:16px;padding:14px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:9px}.dsg-code{display:inline-block;margin-top:8px;font:700 22px ui-monospace,monospace;letter-spacing:.08em;user-select:all}
.dsg-separator{border:0;border-top:1px solid color-mix(in srgb,currentColor 15%,transparent);margin:20px 0}.dsg-input{width:100%;margin-top:8px;padding:9px 11px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;background:transparent;color:inherit;font:inherit}.dsg-help{margin-top:18px!important;font-size:12px;opacity:.7}.dsg-help a{color:inherit}@media(max-width:640px){.dsg-root{padding:18px 16px 28px}.dsg-count{white-space:normal;text-align:right}}
`
  document.head.appendChild(style)
}

async function api(path: string, body?: unknown, signal?: AbortSignal): Promise<Snapshot> {
  const response = await fetch(prefix + path, body === undefined ? { method: 'GET', cache: 'no-store', signal } : {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await response.text()
  let value: Snapshot | undefined
  try { value = text ? JSON.parse(text) as Snapshot : undefined } catch { value = undefined }
  if (!response.ok || !value?.ok) throw new Error(value?.error || `HTTP ${String(response.status)}`)
  return value
}

export function GithubSettings(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<Snapshot>()
  const [error, setError] = React.useState('')
  const [token, setToken] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const statusRequest = React.useRef<{ controller: AbortController; timer: number } | null>(null)
  const pendingAction = React.useRef<symbol | null>(null)
  const cancelRefresh = React.useCallback(() => {
    const request = statusRequest.current
    if (!request) return
    statusRequest.current = null
    window.clearTimeout(request.timer)
    request.controller.abort()
  }, [])
  const refresh = React.useCallback(async (replace = false) => {
    if (pendingAction.current || document.hidden) return
    if (statusRequest.current) {
      if (!replace) return
      cancelRefresh()
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (statusRequest.current !== request) return
      cancelRefresh()
      setError('GitHub status request timed out')
    }, STATUS_TIMEOUT_MS)
    const request = { controller, timer }
    statusRequest.current = request
    try {
      const value = await api('/status', undefined, controller.signal)
      if (statusRequest.current !== request) return
      setSnapshot(value)
      setError('')
    } catch (err) {
      if (statusRequest.current === request) setError(err instanceof Error ? err.message : 'Unable to load status')
    } finally {
      if (statusRequest.current === request) {
        window.clearTimeout(timer)
        statusRequest.current = null
      }
    }
  }, [cancelRefresh])
  React.useEffect(() => {
    // Pause background polling while the tab is hidden; refresh on return.
    let timer: number | undefined
    const stop = (): void => {
      if (timer !== undefined) { window.clearInterval(timer); timer = undefined }
      cancelRefresh()
    }
    const start = (): void => { if (timer === undefined) { void refresh(); timer = window.setInterval(() => { void refresh() }, 3000) } }
    const onVisibility = (): void => { if (document.hidden) stop(); else start() }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      pendingAction.current = null
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [cancelRefresh, refresh])
  const act = async (action: 'connect' | 'cancel' | 'disconnect', input: unknown): Promise<void> => {
    if (pendingAction.current) return
    const request = Symbol()
    pendingAction.current = request
    cancelRefresh()
    setBusy(true)
    setError('')
    try {
      const value = await api(`/${action}`, input)
      if (pendingAction.current !== request) return
      setSnapshot(value)
      if (action === 'connect') setToken('')
    } catch (err) {
      if (pendingAction.current === request) setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      if (pendingAction.current === request) {
        pendingAction.current = null
        setBusy(false)
      }
    }
  }
  const connectOAuth = (): void => { window.open('https://github.com/login/device', '_blank', 'noopener,noreferrer'); void act('connect', { source: 'oauth' }) }
  const copyCode = (): void => {
    const code = snapshot?.authorization?.userCode
    if (!code || !navigator.clipboard) return
    void navigator.clipboard.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000) }).catch(() => undefined)
  }
  const sourceLabels: Record<string, string> = { oauth: 'GitHub OAuth', token: 'personal access token', gh: 'GitHub CLI', env: 'GITHUB_TOKEN environment variable' }
  const status = snapshot?.status ?? 'loading'
  const labels = { loading: 'Loading', idle: 'Not connected', connecting: 'Connecting', authorizing: 'Waiting for GitHub authorization', ready: 'Connected', error: 'Connection failed' }
  const connecting = busy || status === 'connecting' || status === 'authorizing'
  return h('div', { className: 'dsg-root', 'data-dsh-github-settings': '' },
    h('header', { className: 'dsg-head' }, h('div', { className: 'dsg-logo', 'aria-hidden': true }, 'GH'),
      h('div', null, h('h2', { className: 'dsg-title' }, 'GitHub'), h('p', { className: 'dsg-sub' }, 'Connect GitHub to DSH'))),
    h('p', { className: 'dsg-label' }, 'Connection'),
    h('section', { className: 'dsg-card' },
      h('div', { className: 'dsg-status', role: 'status', 'aria-live': 'polite' }, h('span', { className: `dsg-dot ${status}` }),
        h('div', { className: 'dsg-status-copy' }, h('strong', null, labels[status])),
        h('span', { className: 'dsg-count' }, `${String(snapshot?.toolCount ?? 0)} tools available`)),
      h('p', { className: 'dsg-note' }, snapshot?.readOnly ? 'Read-only mode is enabled.' : 'Agents use your GitHub permissions. Write operations require approval.'),
      status === 'ready' && snapshot?.source ? h('p', { className: 'dsg-note' }, `Credential: ${sourceLabels[snapshot.source] ?? snapshot.source}${snapshot.scopes?.length ? ` · granted scopes: ${snapshot.scopes.join(', ')}` : ''}`) : null,
      error || snapshot?.error ? h('p', { className: 'dsg-error', role: 'alert' }, error || snapshot?.error) : null,
      snapshot?.warning ? h('p', { className: 'dsg-error', role: 'alert' }, snapshot.warning) : null,
      snapshot?.requiredScopes?.length ? h('div', { className: 'dsg-error', role: 'alert' },
        h('p', null, `GitHub requires additional permissions: ${snapshot.requiredScopes.join(', ')}. Reconnect to review them on GitHub, then retry the operation.`),
        h('div', { className: 'dsg-actions' }, h('button', { className: 'dsg-button', disabled: connecting || !snapshot?.oauthAvailable, onClick: connectOAuth }, 'Reconnect now'))) : null,
      h('div', { className: 'dsg-actions' },
        h('button', { className: 'dsg-button primary', disabled: connecting || !snapshot?.oauthAvailable, onClick: connectOAuth }, 'Connect with GitHub'),
        h('button', { className: 'dsg-button', disabled: connecting, onClick: () => { void act('connect', { source: 'gh' }) } }, 'Connect with GitHub CLI'),
        status !== 'idle' && status !== 'loading' ? h('button', { className: 'dsg-button', disabled: busy, onClick: () => { void act(status === 'authorizing' ? 'cancel' : 'disconnect', {}) } }, status === 'authorizing' ? 'Cancel' : 'Disconnect') : null,
        h('button', { className: 'dsg-button', disabled: busy, onClick: () => { void refresh(true) } }, 'Refresh status')),
      snapshot && !snapshot.oauthAvailable ? h('p', { className: 'dsg-note' }, 'Browser sign-in is unavailable. Ask the plugin administrator to configure it.') : null,
      status === 'authorizing' && snapshot?.authorization ? h('div', { className: 'dsg-auth' },
        h('p', null, 'Enter this one-time code on GitHub, then approve the requested access:'),
        h('code', { className: 'dsg-code' }, snapshot.authorization.userCode),
        h('div', { className: 'dsg-actions' }, h('a', { className: 'dsg-button', href: 'https://github.com/login/device', target: '_blank', rel: 'noopener noreferrer' }, 'Open GitHub'),
          h('button', { className: 'dsg-button', onClick: copyCode }, copied ? 'Copied' : 'Copy code')),
        h('p', { className: 'dsg-note' }, 'The connection will continue automatically after authorization.')) : null,
      h('p', { className: 'dsg-note' }, 'GitHub CLI must be installed and signed in on the DSH host.'),
      h('hr', { className: 'dsg-separator' }),
      h('label', { htmlFor: 'dsg-token' }, 'Or use a GitHub personal access token'),
      h('input', { id: 'dsg-token', className: 'dsg-input', type: 'password', autoComplete: 'off', value: token, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setToken(event.target.value) }),
      h('div', { className: 'dsg-actions' }, h('button', { className: 'dsg-button', disabled: connecting || !token.trim(), onClick: () => { void act('connect', { source: 'token', token }) } }, 'Connect with token')),
      h('p', { className: 'dsg-note' }, 'The token is encrypted in this profile using the host credential store.')),
    h('p', { className: 'dsg-help' }, h('a', { href: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens', target: '_blank', rel: 'noopener noreferrer' }, 'Learn about GitHub token permissions')))
}

export const name = '@lornatang/dsh-github'
export const inject = ['slots']
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'github', order: 32, label: 'GitHub' }, GithubSettings as React.ComponentType<never>))
}
