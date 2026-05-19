/**
 * Heartbeat writer for the BB external dead-man-switch.
 *
 * The main runtime calls {@link startHeartbeatWriter} when live on Bybit. The
 * writer refreshes a small JSON file (`{pid, ts}`) at a fixed cadence. A
 * separate Bun process (`scripts/bb-watchdog.ts`) polls the file and calls
 * Bybit `cancelAllOpenOrders` when the file ages past a threshold AND the
 * writing PID is no longer alive (or is alive but stale).
 *
 * On graceful shutdown the writer is stopped and the file deleted, so the
 * watchdog can distinguish "stopped intentionally" from "crashed mid-flight".
 *
 * See: docs/operations/dead-man-switch.md
 */

import { writeFileSync, unlinkSync, readFileSync } from 'fs'

export interface HeartbeatRecord {
  /** PID of the process that wrote this heartbeat. */
  pid: number
  /** Unix epoch ms when the heartbeat was written. */
  ts: number
}

/**
 * Write a single heartbeat record to `path`. Pure write — no scheduling.
 *
 * Uses `writeFileSync` so the call cannot interleave with itself; the file is
 * either fully replaced or unchanged. The watchdog parses with try/catch so a
 * partial write (would not happen with sync, but defense in depth) does not
 * crash the polling loop.
 */
export function writeHeartbeat(path: string, record: HeartbeatRecord): void {
  writeFileSync(path, JSON.stringify(record))
}

/**
 * Read the heartbeat file. Returns null when the file is missing OR the
 * contents are unparseable / shape-invalid — both treated as "no live
 * heartbeat", which the watchdog interprets as "main process not running".
 */
export function readHeartbeat(path: string): HeartbeatRecord | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed !== null
      && typeof parsed === 'object'
      && typeof (parsed as { pid?: unknown }).pid === 'number'
      && typeof (parsed as { ts?: unknown }).ts === 'number'
    ) {
      const r = parsed as HeartbeatRecord
      if (Number.isFinite(r.pid) && Number.isFinite(r.ts) && r.pid > 0 && r.ts > 0) {
        return r
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Delete the heartbeat file. Used on graceful shutdown so the watchdog treats
 * the bot as intentionally stopped (no cancel needed). Missing file is fine.
 */
export function deleteHeartbeat(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // File may already be gone — this is a clean-up call, not a guarantee.
  }
}

/**
 * Start the heartbeat writer. Returns a stop function that clears the
 * interval and deletes the file. The first heartbeat is written synchronously
 * before returning so the watchdog can see the bot immediately.
 */
export function startHeartbeatWriter(opts: {
  path: string
  writeMs: number
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Injected for tests. Defaults to `process.pid`. */
  pid?: number
}): () => void {
  const now = opts.now ?? (() => Date.now())
  const pid = opts.pid ?? process.pid

  writeHeartbeat(opts.path, { pid, ts: now() })

  const id = setInterval(() => {
    writeHeartbeat(opts.path, { pid, ts: now() })
  }, opts.writeMs)

  return (): void => {
    clearInterval(id)
    deleteHeartbeat(opts.path)
  }
}

/**
 * Check whether a process with the given PID is alive on the current host.
 *
 * Uses signal 0 — POSIX guarantees this performs the permission check
 * (ESRCH if no such pid, EPERM if not owned by us) without delivering a
 * signal. Returns true on EPERM since "we can't signal it but it exists" is
 * still alive from the watchdog's point of view.
 *
 * Exported so the watchdog can reuse the same liveness rule.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    return false
  }
}
