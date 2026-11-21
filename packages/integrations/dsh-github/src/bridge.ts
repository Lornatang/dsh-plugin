import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Config } from './config.js'
import type { SessionStore, StoredSession } from './store.js'
import { createGithubFetch } from './transport.js'
import { deferredOutputValidation, validateOutput } from './output-validator.js'
import { startDeviceAuthorization, waitForDeviceToken, refreshDeviceToken, parseRequestedScopes, type DeviceAuthorization, type OAuthTokens } from './oauth.js'

const runFile = promisify(execFile)
const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024
const MAX_PAGES = 100
const MAX_TOOLS = 1000
// Report the real package version to the MCP server instead of a stale literal.
const CLIENT_VERSION = (() => {
  try { return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0' } catch { return '0.0.0' }
})()
const STRUCTURAL_KEYS = new Set(['type', 'text', 'annotations', 'priority', 'audience', 'data', 'mimeType', 'resource', 'uri', 'blob'])
const CONTENT_TYPES = new Set(['text', 'image', 'audio', 'resource', 'resource_link'])

const MAX_ERROR_CHARS = 500
const MAX_SECRETS = 16
const MIN_DISCOVERY_MS = 30_000
const MAX_DISCOVERY_MS = 600_000

export interface BridgeHost {
  register(definition: ToolDefinition): () => void
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}
export interface BridgeOptions extends Config {
  store: SessionStore
  /** Whether the host exposes tools/pre-execute. When false, only read-only tools may register. */
  approvalHook?: boolean
}
export type ConnectInput = { source: 'token'; token: string } | { source: 'gh' | 'oauth' }
export type BridgeStatus = 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error'
export interface BridgeSnapshot { status: BridgeStatus; toolCount: number; source?: 'token' | 'gh' | 'env' | 'oauth'; error?: string; warning?: string; readOnly: boolean; oauthAvailable: boolean; requiredScopes?: string[]; scopes?: string[]; authorization?: { userCode: string; verificationUri: string } }
type DiscoveredTool = { name: string; description?: string; inputSchema: unknown; outputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }
type OAuthSession = OAuthTokens & { clientId: string; persisted: boolean; pendingSave?: boolean }

export function publicToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  if (raw === clean && clean.length <= 64) return clean
  const suffix = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 12)
  return `${clean.slice(0, 51)}_${suffix}`
}

function display(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((part: unknown) => {
    if (!part || typeof part !== 'object') return ''
    const block = part as Record<string, unknown>
    return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : `[${String(block['type'] ?? 'unknown')} content]`
  }).filter(Boolean).join('\n\n')
}

function validateToken(token: unknown): string {
  const value = (typeof token === 'string' ? token : '').trim()
  if (!value || value.length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/.test(value)) throw new Error('github: invalid GitHub token')
  return value
}

export class GithubBridge {
  readonly #host: BridgeHost
  readonly #options: BridgeOptions
  #client?: Client
  #tools = new Map<string, { dispose: () => void; approval: boolean }>()
  #status: BridgeStatus = 'idle'
  #source?: 'token' | 'gh' | 'env' | 'oauth'
  #error?: string
  #warning?: string
  #authorization?: { userCode: string; verificationUri: string }
  #requiredScopes?: string[]
  #previousSource?: 'token' | 'gh' | 'env' | 'oauth'
  #previousStore?: StoredSession
  #oauth?: OAuthSession
  #refresh?: Promise<string>
  #secrets = new Set<string>()
  #attemptSecrets = new Set<string>()
  #secretPattern: RegExp | null | undefined
  #generation = 0
  #controller = new AbortController()
  #tail: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(host: BridgeHost, options: BridgeOptions) {
    this.#host = host; this.#options = options
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.serverName)) throw new Error('github: invalid serverName')
    // Validate the origin and toolset before accepting any credential.
    createGithubFetch(new URL(options.url), 'validation-token', options.toolsets, options.readOnly)
    const extraScopes = (options.oauthScopes ?? '').trim()
    if (extraScopes && !parseRequestedScopes(extraScopes)) throw new Error('github: invalid oauthScopes; use comma-separated GitHub OAuth scope names')
  }

  snapshot(): BridgeSnapshot {
    return { status: this.#status, toolCount: this.#tools.size, source: this.#source, error: this.#error, warning: this.#warning, readOnly: this.#options.readOnly, oauthAvailable: !!this.#oauthClientId(), requiredScopes: this.#requiredScopes, scopes: this.#source === 'oauth' ? this.#oauth?.scopes ?? this.#options.store.current.oauthScopes : undefined, authorization: this.#authorization }
  }

  requiresApproval(name: string): boolean { return this.#tools.get(name)?.approval === true }

  async start(): Promise<void> {
    const generation = this.#generation
    await this.#enqueue(async () => {
      if (!this.#active(generation)) return
      try {
        await this.#options.store.load()
        if (!this.#active(generation)) return
        const stored = this.#options.store.current
        const source = this.#options.credentialSource === 'saved' ? stored.source : this.#options.credentialSource
        if (!source) { this.#status = 'idle'; return }
        await this.#establish(source, stored.token, false, generation)
      } catch (error) { this.#fail(generation, error) }
    })
  }

  async connect(input: ConnectInput): Promise<BridgeSnapshot> {
    if ((this.#refresh || this.#oauth?.pendingSave) && !await this.#settleOAuth()) return this.snapshot()
    const previousSource = this.#status === 'ready' ? this.#source : this.#source === 'oauth' ? this.#previousSource ?? this.#options.store.current.source : undefined
    const previousScopes = previousSource === 'oauth' ? this.#oauth?.scopes ?? this.#options.store.current.oauthScopes : undefined
    const previousStore = this.#status === 'ready' ? this.#options.store.current : this.#previousStore ?? this.#options.store.current
    const generation = this.#invalidate()
    this.#previousSource = input.source === 'oauth' ? previousSource : undefined
    this.#previousStore = input.source === 'oauth' ? previousStore : undefined
    await this.#enqueue(async () => {
      if (!this.#active(generation)) return
      try {
        await this.#shutdownClient()
        if (!this.#active(generation)) return
        if (input.source === 'oauth') {
          this.#status = 'connecting'; this.#source = 'oauth'; this.#error = undefined
          const clientId = this.#oauthClientId()
          const authorization = await startDeviceAuthorization(clientId, this.#controller.signal, [...(previousScopes ?? []), ...(this.#requiredScopes ?? []), ...(parseRequestedScopes(this.#options.oauthScopes ?? '') ?? [])])
          if (!this.#active(generation)) return
          this.#status = 'authorizing'
          this.#authorization = { userCode: authorization.userCode, verificationUri: authorization.verificationUri }
          void this.#finishAuthorization(clientId, authorization, generation)
        } else {
          await this.#establish(input.source, input.source === 'token' ? input.token : undefined, true, generation)
        }
      } catch (error) { this.#fail(generation, error) }
    })
    return this.snapshot()
  }

  async cancel(): Promise<BridgeSnapshot> {
    if (this.#source !== 'oauth' || (this.#status !== 'authorizing' && this.#status !== 'connecting')) return this.snapshot()
    if ((this.#refresh || this.#oauth?.pendingSave) && !await this.#settleOAuth()) return this.snapshot()
    const previousSource = this.#previousSource
    const previousStore = this.#previousStore
    const requiredScopes = this.#requiredScopes
    const generation = this.#invalidate()
    await this.#enqueue(async () => {
      await this.#shutdownClient()
      if (!this.#active(generation)) return
      this.#status = 'idle'; this.#source = undefined; this.#error = undefined
      try {
        if (previousStore && this.#options.store.current !== previousStore) {
          await this.#options.store.patch({ source: previousStore.source, token: previousStore.token, oauthClientId: previousStore.oauthClientId, oauthRefreshToken: previousStore.oauthRefreshToken, oauthExpiresAt: previousStore.oauthExpiresAt, oauthScopes: previousStore.oauthScopes }, () => this.#active(generation))
        }
        const stored = previousStore ?? this.#options.store.current
        const source = previousSource ?? (this.#options.credentialSource === 'saved' ? stored.source : this.#options.credentialSource)
        if (source) await this.#establish(source, stored.token, false, generation)
        if (this.#active(generation)) { this.#requiredScopes = requiredScopes; this.#previousSource = undefined; this.#previousStore = undefined }
      } catch (error) { this.#fail(generation, error) }
    })
    return this.snapshot()
  }

  async disconnect(): Promise<BridgeSnapshot> {
    if (this.#refresh) await this.#refresh.catch(() => undefined)
    const generation = this.#invalidate()
    this.#previousSource = undefined; this.#previousStore = undefined
    await this.#enqueue(async () => {
      await this.#shutdownClient()
      if (!this.#active(generation)) return
      try { await this.#options.store.destroy() }
      catch (error) { this.#fail(generation, error); return }
      if (!this.#active(generation)) return
      this.#status = 'idle'; this.#source = undefined; this.#error = undefined; this.#requiredScopes = undefined
    })
    return this.snapshot()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    if (this.#refresh || this.#oauth?.pendingSave) await this.#settleOAuth()
    if (this.#disposed) return
    this.#disposed = true
    this.#invalidate()
    await this.#enqueue(async () => { await this.#shutdownClient(); this.#secrets.clear(); this.#attemptSecrets.clear(); this.#secretPattern = undefined })
  }

  #active(generation: number): boolean { return !this.#disposed && generation === this.#generation }
  #invalidate(): number {
    this.#generation++
    this.#controller.abort()
    this.#controller = new AbortController()
    this.#authorization = undefined
    this.#warning = undefined
    this.#oauth = undefined; this.#refresh = undefined
    this.#attemptSecrets.clear()
    this.#secretPattern = undefined
    return this.#generation
  }
  async #enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(work, work)
    this.#tail = run.catch(() => undefined)
    return run
  }
  #redact(message: string): string {
    const pattern = this.#redactionPattern()
    return pattern ? message.replace(pattern, '[REDACTED]') : message
  }
  // One cached alternation replaces every secret in a single pass. Rebuilding
  // and sorting the secret list per string made large results O(secrets x bytes),
  // and sequential replacement could corrupt an inserted [REDACTED] marker when
  // a later secret matched text inside it.
  #redactionPattern(): RegExp | null {
    if (this.#secretPattern !== undefined) return this.#secretPattern
    this.#pruneSecrets()
    const secrets = [...new Set([...this.#secrets, ...this.#attemptSecrets])].filter(Boolean).sort((a, b) => b.length - a.length)
    this.#secretPattern = secrets.length ? new RegExp(secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null
    return this.#secretPattern
  }
  // Rotation adds a new token per refresh, so an unbounded set would slowly
  // grow the alternation and slow every redacted result. Insertion order tracks
  // age, and the newest tokens are the ones a live client can still return.
  #pruneSecrets(): void {
    if (this.#secrets.size <= MAX_SECRETS) return
    for (const secret of this.#secrets) {
      if (this.#secrets.size <= MAX_SECRETS) break
      this.#secrets.delete(secret)
    }
  }
  #redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.#redact(value)
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) continue
        const part: unknown = value[i]
        const redacted = this.#redactValue(part)
        if (!copy && !Object.is(redacted, part)) {
          copy = value.slice(0, i)
          copy.length = value.length
        }
        if (copy) copy[i] = redacted
      }
      return copy ?? value
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      let changed = false
      for (const entry of entries) {
        const [key, part] = entry
        const redactedKey = STRUCTURAL_KEYS.has(key) ? key : this.#redact(key)
        const redactedPart = key === 'type' && typeof part === 'string' && CONTENT_TYPES.has(part) ? part : this.#redactValue(part)
        if (redactedKey === key && Object.is(redactedPart, part)) continue
        entry[0] = redactedKey
        entry[1] = redactedPart
        changed = true
      }
      // Keep clean references and build changed objects with own data properties.
      return changed ? Object.fromEntries(entries) : value
    }
    return value
  }
  #fail(generation: number, error: unknown): void {
    if (!this.#active(generation)) return
    this.#status = 'error'
    this.#authorization = undefined
    // Upstream error bodies are untrusted and can be large; keep a short text only.
    const text = error instanceof Error ? error.message : 'GitHub connection failed'
    this.#error = this.#redact(text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text)
    this.#attemptSecrets.clear()
    this.#secretPattern = undefined
    this.#host.logger.error(`github: ${this.#error}`)
  }

  #oauthClientId(): string { return (this.#options.oauthClientId || process.env['DSH_GITHUB_OAUTH_CLIENT_ID'] || '').trim() }

  async #finishAuthorization(clientId: string, authorization: DeviceAuthorization, generation: number): Promise<void> {
    try {
      const tokens = await waitForDeviceToken(clientId, authorization, this.#controller.signal)
      if (!this.#active(generation)) return
      await this.#enqueue(async () => {
        if (!this.#active(generation)) return
        this.#authorization = undefined
        this.#oauth = { ...tokens, clientId, persisted: false }
        await this.#establish('oauth', tokens.accessToken, true, generation)
      })
    } catch (error) { this.#fail(generation, error) }
  }

  async #credential(source: 'token' | 'gh' | 'env' | 'oauth', token?: string): Promise<string> {
    if (source === 'token' || source === 'oauth') return validateToken(token ?? '')
    if (source === 'env') return validateToken(process.env['GITHUB_TOKEN'] ?? '')
    try {
      const result = await runFile('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', timeout: 10000, maxBuffer: 8192, windowsHide: true })
      return validateToken(result.stdout)
    } catch { throw new Error('github: GitHub CLI is unavailable or not authenticated; run gh auth login') }
  }

  async #settleOAuth(): Promise<boolean> {
    const pending = this.#refresh
    if (pending) {
      await pending.catch(() => undefined)
      if (this.#refresh === pending) this.#refresh = undefined
    }
    if (this.#oauth?.pendingSave && this.#active(this.#generation)) {
      await this.#oauthToken(this.#generation).catch(() => undefined)
    }
    return !this.#oauth?.pendingSave
  }

  async #oauthToken(generation: number): Promise<string> {
    const session = this.#oauth
    if (!session || !this.#active(generation)) throw new Error('github: connection cancelled')
    const expiring = !!session.expiresAt && session.expiresAt <= Date.now() + 60000
    if (!expiring && !session.pendingSave) return session.accessToken
    const refresh = this.#refresh ?? (this.#refresh = (async () => {
      if (expiring) {
        if (!session.refreshToken || !session.clientId) throw new Error('GitHub authorization expired; connect again')
        const next = await refreshDeviceToken(session.clientId, session.refreshToken, this.#controller.signal)
        if (!this.#active(generation) || this.#oauth !== session) throw new Error('github: connection cancelled')
        const secrets = session.persisted ? this.#secrets : this.#attemptSecrets
        secrets.add(next.accessToken)
        if (next.refreshToken) secrets.add(next.refreshToken)
        this.#secretPattern = undefined
        const scopes = next.scopes ?? session.scopes
        Object.assign(session, next, { scopes })
        if (session.persisted) session.pendingSave = true
      }
      if (session.pendingSave) {
        try {
          await this.#options.store.patch({ token: session.accessToken, oauthRefreshToken: session.refreshToken, oauthExpiresAt: session.expiresAt, oauthClientId: session.clientId, oauthScopes: session.scopes }, () => this.#active(generation) && this.#oauth === session)
          session.pendingSave = false; this.#warning = undefined
        } catch (error) {
          if (!this.#active(generation) || this.#oauth !== session) throw error
          this.#warning = 'Unable to save refreshed GitHub credentials. Keep DSH running while storage access is restored.'
          this.#host.logger.warn(`github: ${this.#warning}`)
        }
      }
      return session.accessToken
    })())
    try { return await refresh }
    catch (error) {
      if (this.#active(generation) && this.#oauth === session) {
        this.#fail(generation, error)
        // Close the dead-token client, but only after the refresh error has
        // reached the in-flight calls: closing the transport synchronously
        // would reject them with "Connection closed" instead of the actionable
        // reauthorization message. Error propagation is all microtasks, so a
        // deferred macrotask runs after it; skip the close if the client was
        // already replaced or shut down by then.
        const dead = this.#client
        const shutdown = setTimeout(() => { if (this.#client === dead) void this.#shutdownClient() }, 0)
        shutdown.unref()
      }
      throw error
    } finally { if (this.#refresh === refresh) this.#refresh = undefined }
  }

  async #establish(source: 'token' | 'gh' | 'env' | 'oauth', supplied: string | undefined, save: boolean, generation: number): Promise<void> {
    const signal = this.#controller.signal
    this.#status = 'connecting'; this.#source = source; this.#error = undefined
    let token = await this.#credential(source, supplied)
    if (!this.#active(generation)) return
    this.#attemptSecrets.add(token)
    this.#secretPattern = undefined
    if (source === 'oauth' && !this.#oauth) {
      const stored = this.#options.store.current
      this.#oauth = { accessToken: token, refreshToken: stored.oauthRefreshToken, expiresAt: stored.oauthExpiresAt, scopes: stored.oauthScopes, clientId: stored.oauthClientId || this.#oauthClientId(), persisted: true }
    }
    if (source === 'oauth') {
      if (this.#oauth?.refreshToken) { this.#attemptSecrets.add(this.#oauth.refreshToken); this.#secretPattern = undefined }
      token = await this.#oauthToken(generation)
    }
    if (!this.#active(generation)) return
    const client = new Client({ name: 'dsh-github', version: CLIENT_VERSION }, { jsonSchemaValidator: deferredOutputValidation })
    let events = 0
    let since = Date.now()
    const serverUrl = new URL(this.#options.url)
    const safeFetch = createGithubFetch(serverUrl, source === 'oauth' ? () => this.#oauthToken(generation) : token, this.#options.toolsets, this.#options.readOnly, {
      onInsufficientScope: source === 'oauth' ? (value) => {
        const scopes = parseRequestedScopes(value)
        if (!this.#active(generation)) return undefined
        if (!scopes) {
          this.#warning = 'GitHub requested a permission this plugin does not recognize. Update the plugin before retrying.'
          return this.#warning
        }
        this.#requiredScopes = [...new Set([...(this.#requiredScopes ?? []), ...scopes])]
        return `GitHub requires additional permissions (${this.#requiredScopes.join(', ')}). Connect again in GitHub settings, approve them, and retry the operation.`
      } : undefined,
      onEvent: () => {
        const now = Date.now()
        if (now - since >= 10000) { since = now; events = 0 }
        if (++events > 1000) throw new Error('MCP server sent too many events')
      },
    })
    const fetch: FetchLike = (value, init) => {
      const isEventStream = (init?.method?.toUpperCase() ?? 'GET') === 'GET' && (new Headers(init?.headers).get('accept') ?? '').includes('text/event-stream')
      const signals = [signal]
      if (!isEventStream) signals.push(AbortSignal.timeout(this.#options.toolCallTimeoutMs))
      if (init?.signal) signals.push(init.signal)
      return safeFetch(value, { ...init, signal: AbortSignal.any(signals) })
    }
    const transport = new StreamableHTTPClientTransport(serverUrl, { fetch })
    client.onclose = () => {
      if (this.#client === client && this.#active(generation)) {
        this.#client = undefined; this.#clearTools(); this.#status = 'error'; this.#error = 'GitHub MCP connection closed; reconnect to continue'
      }
    }
    try {
      await client.connect(transport, { signal, timeout: this.#options.toolCallTimeoutMs })
      if (!this.#active(generation)) throw new Error('connection cancelled')
      const tools = await this.#discover(client, signal)
      if (!this.#active(generation)) throw new Error('connection cancelled')
      if (save && source !== 'env') {
        const oauth = source === 'oauth' ? this.#oauth : undefined
        await this.#options.store.patch({ source, token: source === 'oauth' ? oauth?.accessToken : source === 'token' ? token : undefined, oauthClientId: oauth?.clientId, oauthRefreshToken: oauth?.refreshToken, oauthExpiresAt: oauth?.expiresAt, oauthScopes: oauth?.scopes }, () => this.#active(generation))
        if (oauth) oauth.persisted = true
      }
      if (!this.#active(generation)) throw new Error('connection cancelled')
      this.#client = client
      this.#register(client, tools, signal)
      if (!this.#active(generation)) throw new Error('connection cancelled')
      this.#status = 'ready'; this.#error = undefined
      // Retired credentials cannot appear in results from this client. Replace
      // the redaction set instead of accumulating every token seen since start.
      const activeSecrets = new Set(this.#attemptSecrets)
      if (this.#oauth) {
        activeSecrets.add(this.#oauth.accessToken)
        if (this.#oauth.refreshToken) activeSecrets.add(this.#oauth.refreshToken)
      }
      this.#secrets = activeSecrets
      this.#attemptSecrets.clear()
      this.#secretPattern = undefined
      this.#previousSource = undefined
      this.#previousStore = undefined
      this.#requiredScopes = undefined
    } catch (error) {
      if (this.#client === client) { this.#client = undefined; this.#clearTools() }
      await client.close().catch(() => undefined)
      throw error
    }
  }

  async #discover(client: Client, signal: AbortSignal): Promise<DiscoveredTool[]> {
    const budget = Math.min(Math.max(this.#options.toolCallTimeoutMs * 4, MIN_DISCOVERY_MS), MAX_DISCOVERY_MS)
    signal = AbortSignal.any([signal, AbortSignal.timeout(budget)])
    const tools: DiscoveredTool[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    let bytes = 0
    do {
      if (cursors.size >= MAX_PAGES) throw new Error('MCP server returned too many tool pages')
      const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: this.#options.toolCallTimeoutMs })
      bytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
      if (bytes > MAX_DISCOVERY_BYTES || tools.length + page.tools.length > MAX_TOOLS) throw new Error('MCP tool discovery exceeds its limit')
      tools.push(...page.tools)
      cursor = page.nextCursor
      if (cursor && cursors.has(cursor)) throw new Error('MCP server repeated a continuation cursor')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    const names = new Set<string>()
    for (const tool of tools) {
      const name = publicToolName(this.#options.serverName, tool.name)
      if (names.has(name)) throw new Error('MCP server returned duplicate tool names')
      names.add(name)
    }
    return tools
  }

  #register(client: Client, tools: DiscoveredTool[], connectionSignal: AbortSignal): void {
    this.#clearTools()
    try {
      for (const tool of tools) {
        // In read-only mode, or without an approval channel in the host, only
        // tools the server marks read-only may register; anything else would
        // bypass the requested restriction or the approval prompt.
        if ((this.#options.readOnly || this.#options.approvalHook === false) && tool.annotations?.readOnlyHint !== true) continue
        const name = publicToolName(this.#options.serverName, tool.name)
        const definition = {
          name, description: tool.description ?? '', parameters: tool.inputSchema,
          output: {
            schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
            render: (_args: unknown, result: unknown) => [{ type: 'text', text: display((result as { content?: unknown })?.content) }],
          },
          execute: async (args: unknown, context: { signal?: AbortSignal }) => {
            const signal = context.signal ? AbortSignal.any([connectionSignal, context.signal]) : connectionSignal
            try {
              const result = await client.callTool({ name: tool.name, arguments: (typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown> }, undefined, { timeout: this.#options.toolCallTimeoutMs, signal })
              if (result.isError) throw new Error(display(result.content) || 'GitHub MCP tool failed')
              if (tool.outputSchema) {
                if (result.structuredContent === undefined) throw new Error(`github: tool ${tool.name} did not return structured output`)
                await validateOutput(tool.outputSchema, result.structuredContent, this.#options.toolCallTimeoutMs, signal)
              }
              if (Array.isArray(result.content) && result.content.length) return { content: this.#redactValue(result.content) as unknown[] }
              if (result.structuredContent === undefined) return { content: [] }
              return { content: [{ type: 'text', text: JSON.stringify(this.#redactValue(result.structuredContent)) }] }
            } catch (error) {
              const original = error instanceof Error ? error.message : 'GitHub MCP tool failed'
              const message = this.#redact(original)
              // GitHub reports workflow-write refusals as tool errors, not HTTP
              // scope challenges, so route them into the same reauthorization flow.
              if (!connectionSignal.aborted && this.#source === 'oauth' && /without `?workflow`? scope/.test(message)) {
                this.#requiredScopes = [...new Set([...(this.#requiredScopes ?? []), 'workflow'])]
                throw new Error(`GitHub requires additional permissions (${this.#requiredScopes.join(', ')}). Connect again in GitHub settings, approve them, and retry the operation.`)
              }
              // Preserve cancellation and MCP error identity unless redaction changes the text.
              if (message === original) throw error
              const wrapped = new Error(message, { cause: error })
              if (error instanceof Error) wrapped.name = error.name
              throw wrapped
            }
          },
        } as ToolDefinition
        this.#tools.set(name, { dispose: this.#host.register(definition), approval: tool.annotations?.readOnlyHint !== true })
      }
    } catch (error) { this.#clearTools(); throw error }
  }

  async #shutdownClient(): Promise<void> {
    const client = this.#client
    this.#client = undefined
    this.#clearTools()
    await client?.close().catch(() => undefined)
  }
  #clearTools(): void {
    for (const tool of this.#tools.values()) tool.dispose()
    this.#tools.clear()
  }
}
