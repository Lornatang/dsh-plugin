/** Keep one live gate per profile without leaving a stale lock after a crash. */
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tightenState } from './state.ts'

/** Create or open a regular per-profile SQLite file with private POSIX permissions. */
export function openProfileDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    // Do not open an existing lock file outside SQLite: on POSIX, closing a
    // separate descriptor can release this process's advisory file locks.
    const fd = openSync(path, 'wx', 0o600)
    closeSync(fd)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  tightenState(path)
  return new DatabaseSync(path)
}

/**
 * SQLite releases this dedicated database's OS lock when the process exits.
 * Use a local filesystem with working SQLite file locking for shared profiles.
 */
export function acquireStateLock(statePath: string): () => void {
  const database = openProfileDatabase(statePath + '.lock.sqlite')
  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
  } catch (err) {
    database.close()
    throw new Error('dsh-frontgate: cannot lock profile state; another gate may be running: ' + statePath, { cause: err })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    database.close()
  }
}
