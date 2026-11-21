/** Persistent session admission and legacy cookie revocation. */
import { createHash } from 'node:crypto'
import { LEGACY_TOKEN_VERSION, isLegacyToken, newSessionEpoch, signToken, verifyToken } from './auth.ts'
import { openProfileDatabase } from './state-lock.ts'
import { MAX_REVOKED_SESSIONS, appendRevocation, compactRevocations, mergeRevocation, readState, revocationRecords, tightenState, writeState } from './state.ts'
import type { State } from './state.ts'

const MAX_ACTIVE_SESSIONS = 10000
const nowSeconds = (): number => Math.floor(Date.now() / 1000)
const tokenExpiry = (token: string): number => Number(token.split('.')[2])

/** Store only a digest, never the bearer token itself. */
export const sessionDigest = (token: string): string => createHash('sha256').update(token).digest('base64url')

function createSessionRegistry(path: string, epoch: string) {
  const database = openProfileDatabase(path + '.sessions.sqlite')
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        digest TEXT PRIMARY KEY, epoch TEXT NOT NULL, expires INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires);
    `)
    database.prepare('DELETE FROM sessions WHERE epoch != ?').run(epoch)
    const prune = database.prepare('DELETE FROM sessions WHERE expires <= ?')
    const insert = database.prepare(`
      INSERT INTO sessions (digest, epoch, expires)
      SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM sessions) < ?
    `)
    const find = database.prepare('SELECT 1 FROM sessions WHERE digest = ? AND epoch = ? AND expires > ?')
    const remove = database.prepare('DELETE FROM sessions WHERE digest = ? AND epoch = ?')
    return {
      issue(digest: string, expires: number, now: number): boolean {
        prune.run(now)
        // Admission consumes a row in one atomic write. Revocation only deletes,
        // so it has no dependency on spare capacity.
        return insert.run(digest, epoch, expires, MAX_ACTIVE_SESSIONS).changes === 1
      },
      has: (digest: string, now: number): boolean => find.get(digest, epoch, now) !== undefined,
      revoke: (digest: string): boolean => remove.run(digest, epoch).changes === 1,
      close: (): void => database.close(),
    }
  } catch (err) {
    database.close()
    throw err
  }
}

export interface SessionStore {
  issue(): string | undefined
  valid(token: string): boolean
  /** Persist revocation before reporting logout success. */
  revoke(token: string): boolean
  close(): void
}

export function createSessionStore(path: string, state: State, ttlSeconds: number,
  onRevoke: (digest: string | undefined) => void): SessionStore {
  const secret = state.secret!
  const passwordHash = state.passwordHash!
  const managedEpoch = state.managedSessionEpoch!
  let legacyEpoch = state.sessionEpoch!
  let revoked = new Map((state.revokedSessions ?? []).map(({ digest, expires }) => [digest, expires]))
  const registry = createSessionRegistry(path, managedEpoch)

  function currentState(now: number, includeRevocations: boolean): State {
    if (!tightenState(path)) throw new Error('state file is missing')
    const latest = readState(path, true, now, includeRevocations)
    if (latest.secret !== secret || latest.passwordHash !== passwordHash ||
        latest.managedSessionEpoch !== managedEpoch || latest.sessionEpoch !== legacyEpoch) {
      throw new Error('state changed; restart the gate before changing sessions')
    }
    return latest
  }

  const issue = (): string | undefined => {
    const now = nowSeconds()
    currentState(now, false)
    const token = signToken(secret, managedEpoch, ttlSeconds)
    return registry.issue(sessionDigest(token), tokenExpiry(token), now) ? token : undefined
  }

  const valid = (token: string): boolean => {
    if (!isLegacyToken(token)) {
      return verifyToken(secret, managedEpoch, token) && registry.has(sessionDigest(token), nowSeconds())
    }
    if (!verifyToken(secret, legacyEpoch, token, LEGACY_TOKEN_VERSION)) return false
    const digest = sessionDigest(token)
    const expires = revoked.get(digest)
    if (expires === undefined) return true
    if (expires > nowSeconds()) return false
    revoked.delete(digest)
    return true
  }

  function revokeLegacy(digest: string, expires: number, now: number, latest: State): void {
    const next = new Map((latest.revokedSessions ?? []).map((entry) => [entry.digest, entry.expires]))
    for (const [key, expiry] of revoked) mergeRevocation(next, { digest: key, expires: expiry }, now)
    if (!next.has(digest) && next.size >= MAX_REVOKED_SESSIONS) {
      // Old cookies had no admission registry. If their revocation table is
      // already full, commit a fresh legacy epoch before closing their streams.
      // Tracked sessions use their own epoch and stay connected.
      const epoch = newSessionEpoch()
      writeState(path, { ...latest, sessionEpoch: epoch, revokedSessions: revocationRecords(next) })
      legacyEpoch = epoch
      revoked = next
      onRevoke(undefined)
      return
    }
    const entry = { digest, expires }
    if (!appendRevocation(path, entry)) {
      compactRevocations(path, latest, revocationRecords(next))
      if (!appendRevocation(path, entry)) throw new Error('revocation journal is full after compaction')
    }
    mergeRevocation(next, entry, now)
    revoked = next
    onRevoke(digest)
  }

  const revoke = (token: string): boolean => {
    if (!valid(token)) return false
    const legacy = isLegacyToken(token)
    const now = nowSeconds()
    const expires = tokenExpiry(token)
    if (expires <= now) return false
    const latest = currentState(now, legacy)
    const digest = sessionDigest(token)
    if (legacy) {
      revokeLegacy(digest, expires, now, latest)
      return true
    }
    if (!registry.revoke(digest)) return false
    onRevoke(digest)
    return true
  }

  return { issue, valid, revoke, close: registry.close }
}
