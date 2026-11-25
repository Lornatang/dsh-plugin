import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  COOKIE, clearCookie, sessionCookie, verifyPassword,
} from './auth.ts'
import {
  MAX_FORM, clientIp, cookieValue, hostMatchesPublicOrigin, html, json, readForm, redirect, safeNext,
  sameOrigin, text,
} from './http.ts'
import { loginPage } from './page.ts'
import type { LogSink } from './context.ts'

const MAX_TRACKED_CLIENTS = 1024
const CHECK_CONCURRENCY = 2

/** Values the gate needs at request time. */
export interface GateRuntime {
  title: string
  passwordHash: string
  sessionSeconds: number
  maxAttempts: number
  maxPendingLoginsPerIp: number
  lockMs: number
  trustProxy: boolean
  useTls: boolean
  publicOrigin: string
  secureCookie: boolean
}

/** Collaborators the handler delegates to. */
export interface GateOptions {
  runtime: GateRuntime
  harnessCookie(): Promise<string>
  issueSession(): string | undefined
  validSession(token: string): boolean
  revokeSession(token: string): boolean
  admit(req: IncomingMessage, res: ServerResponse, token: string): boolean
  forward(req: IncomingMessage, res: ServerResponse, cookie: string, token: string): void
  log: LogSink
}

interface Failure {
  count: number
  until: number
  expiresAt: number
}

/** Build the request handler for one gate instance. */
export function createHandler(options: GateOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { runtime, harnessCookie, issueSession, validSession, revokeSession, forward, log } = options
  const { title, passwordHash, sessionSeconds, maxAttempts, maxPendingLoginsPerIp, lockMs, trustProxy, useTls, publicOrigin, secureCookie } = runtime

  // Login throttling: per-client lockout plus a global scrypt slot limit.
  const failures = new Map<string, Failure>()
  const clientsInFlight = new Set<string>()
  const pendingForms = new Map<string, number>()

  function lockRemaining(ip: string): number {
    const now = Date.now()
    const entry = failures.get(ip)
    if (entry) {
      if (entry.expiresAt > now || clientsInFlight.has(ip)) return Math.max(0, entry.until - now)
      failures.delete(ip)
    }
    if (failures.size < MAX_TRACKED_CLIENTS) return 0

    // Prune expired records first, or evict the oldest partial count under pressure.
    // Keep live lockouts and in-flight checks until they can safely expire.
    let earliest = Infinity
    let oldestPartial = Infinity
    let victim: string | undefined
    for (const [client, failure] of failures) {
      const inFlight = clientsInFlight.has(client)
      if (failure.expiresAt <= now && !inFlight) {
        failures.delete(client)
        continue
      }
      earliest = Math.min(earliest, failure.expiresAt)
      if (!inFlight && failure.until <= now && failure.expiresAt < oldestPartial) {
        oldestPartial = failure.expiresAt
        victim = client
      }
    }
    if (failures.size < MAX_TRACKED_CLIENTS) return 0
    if (victim === undefined) return Math.max(1000, earliest - now)
    failures.delete(victim)
    return 0
  }

  function sessionOf(req: IncomingMessage): boolean {
    const token = cookieValue(req.headers.cookie, COOKIE)
    return Boolean(token) && validSession(token)
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse, search: string): Promise<void> {
    const next = safeNext(new URLSearchParams(search).get('next') || '/')
    if (req.method === 'POST') {
      if (!sameOrigin(req, publicOrigin, useTls)) {
        req.resume()
        res.setHeader('connection', 'close')
        return html(res, 403, loginPage(title, next, 'Origin check failed.'))
      }
      const declared = Number(req.headers['content-length'] || 0)
      if (declared > MAX_FORM) {
        req.resume()
        return text(res, 413, 'request body too large\n', { connection: 'close' })
      }
      const ip = clientIp(req, trustProxy)
      const wait = lockRemaining(ip)
      if (wait > 0) {
        req.resume()
        return text(res, 429, 'too many attempts\n', { 'retry-after': String(Math.ceil(wait / 1000)), connection: 'close' })
      }
      const pending = pendingForms.get(ip) ?? 0
      if (pending >= maxPendingLoginsPerIp) {
        req.resume()
        return text(res, 429, 'too many pending logins\n', { 'retry-after': '1', connection: 'close' })
      }
      pendingForms.set(ip, pending + 1)
      let form: string
      try {
        form = await readForm(req)
      } catch (err) {
        if (res.destroyed) return
        if ((err as Error).message === 'too large') return text(res, 413, 'request body too large\n', { connection: 'close' })
        if ((err as Error).message === 'timeout') return text(res, 408, 'request timeout\n', { connection: 'close' })
        return text(res, 400, 'bad request\n', { connection: 'close' })
      } finally {
        const count = pendingForms.get(ip) ?? 1
        if (count <= 1) pendingForms.delete(ip)
        else pendingForms.set(ip, count - 1)
      }
      const remaining = lockRemaining(ip)
      if (remaining > 0) return text(res, 429, 'too many attempts\n', { 'retry-after': String(Math.ceil(remaining / 1000)) })
      if (clientsInFlight.has(ip) || clientsInFlight.size >= CHECK_CONCURRENCY) {
        return text(res, 429, 'busy, retry shortly\n', { 'retry-after': '1' })
      }
      const previous = failures.get(ip)
      const failure = previous ?? { count: 0, until: 0, expiresAt: Date.now() + lockMs }
      if (!previous) failures.set(ip, failure)
      clientsInFlight.add(ip)
      let ok: boolean
      try {
        ok = await verifyPassword(new URLSearchParams(form).get('password') || '', passwordHash)
      } catch (err) {
        if (!previous) failures.delete(ip)
        throw err
      } finally {
        clientsInFlight.delete(ip)
      }
      if (!ok) {
        failure.count += 1
        failure.expiresAt = Date.now() + lockMs
        if (failure.count >= maxAttempts) {
          failure.count = 0
          failure.until = failure.expiresAt
        }
        log.info('login failed from ' + ip)
        return html(res, 401, loginPage(title, next, 'Wrong password.'))
      }
      failures.delete(ip)
      if (res.destroyed) return
      let token: string | undefined
      try { token = issueSession() } catch (err) {
        log.warn('could not start session: ' + (err as Error).message)
        return text(res, 503, 'could not start session; retry later\n')
      }
      if (!token) return text(res, 429, 'session limit reached; sign out of another session and retry\n')
      log.info('login from ' + ip)
      res.setHeader('set-cookie', sessionCookie(token, sessionSeconds, secureCookie))
      return redirect(res, next, 303)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return text(res, 405, 'method not allowed\n', { allow: 'GET, POST' })
    }
    if (sessionOf(req)) return redirect(res, '/')
    return html(res, 200, loginPage(title, next, ''))
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url || '/'
    if (!raw.startsWith('/')) return text(res, 400, 'bad request\n')
    const queryAt = raw.indexOf('?')
    const path = queryAt === -1 ? raw : raw.slice(0, queryAt)
    const search = queryAt === -1 ? '' : raw.slice(queryAt)

    if (path === '/__gate/health') return json(res, 200, { ok: true, service: 'dsh-frontgate' })
    if (!hostMatchesPublicOrigin(req, publicOrigin, useTls)) return text(res, 403, 'invalid host\n')
    if (path === '/__gate/login') return handleLogin(req, res, search)
    if (path === '/__gate/logout') {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        return text(res, 405, 'method not allowed\n', { allow: 'GET, HEAD, POST' })
      }
      if (!sameOrigin(req, publicOrigin, useTls)) return text(res, 403, 'forbidden\n')
      const token = cookieValue(req.headers.cookie, COOKIE)
      if (token && validSession(token)) {
        try { revokeSession(token) } catch (err) {
          log.warn('could not revoke session: ' + (err as Error).message)
          return text(res, 503, 'could not sign out; retry later\n')
        }
      }
      res.setHeader('set-cookie', clearCookie(secureCookie))
      res.setHeader('clear-site-data', '"cache"')
      return redirect(res, '/__gate/login')
    }
    if (path.startsWith('/__gate/')) return text(res, 404, 'not found\n')

    const isApi = path === '/api' || path.startsWith('/api/')
    const token = cookieValue(req.headers.cookie, COOKIE)
    const unauthorized = (): void => {
      if (isApi) {
        return json(res, 401, { error: 'unauthorized', login: '/__gate/login' })
      }
      return redirect(res, '/__gate/login?next=' + encodeURIComponent(raw))
    }
    if (!token || !validSession(token)) return unauthorized()

    if (!sameOrigin(req, publicOrigin, useTls)) {
      log.warn('cross-origin request blocked: ' + String(req.method) + ' ' + path)
      if (isApi) return json(res, 403, { error: 'forbidden' })
      return text(res, 403, 'forbidden\n')
    }

    if (!options.admit(req, res, token)) return

    let cookie: string
    try {
      cookie = await harnessCookie()
    } catch (err) {
      if (res.destroyed) return
      log.warn('harness cookie exchange failed: ' + (err as Error).message)
      return json(res, 503, { error: 'harness_unavailable' })
    }
    if (req.aborted || res.destroyed || !res.writable) return
    if (!validSession(token)) return unauthorized()
    forward(req, res, cookie, token)
  }
}
