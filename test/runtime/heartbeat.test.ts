import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeHeartbeat,
  readHeartbeat,
  deleteHeartbeat,
  startHeartbeatWriter,
  isPidAlive,
} from '../../src/runtime/heartbeat.js'

/**
 * Heartbeat writer/reader behavior. These tests use a tmp directory so the
 * default /tmp path is never touched. The writer's interval is exercised by
 * waiting a small multiple of the configured cadence and asserting that the
 * file timestamp moved forward.
 */
describe('heartbeat writer', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'minh-hb-'))
    path = join(dir, 'heartbeat.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('writeHeartbeat / readHeartbeat', () => {
    it('round-trips a record', () => {
      writeHeartbeat(path, { pid: 12345, ts: 1_700_000_000_000 })
      const rec = readHeartbeat(path)
      expect(rec).toEqual({ pid: 12345, ts: 1_700_000_000_000 })
    })

    it('overwrites prior contents on each write', () => {
      writeHeartbeat(path, { pid: 1, ts: 1 })
      writeHeartbeat(path, { pid: 2, ts: 2 })
      expect(readHeartbeat(path)).toEqual({ pid: 2, ts: 2 })
    })

    it('returns null when the file is missing', () => {
      expect(readHeartbeat(path)).toBeNull()
    })

    it('returns null on unparseable contents', () => {
      writeFileSync(path, 'not json')
      expect(readHeartbeat(path)).toBeNull()
    })

    it('returns null when shape is invalid (missing pid)', () => {
      writeFileSync(path, JSON.stringify({ ts: 1 }))
      expect(readHeartbeat(path)).toBeNull()
    })

    it('returns null when pid is non-positive', () => {
      writeFileSync(path, JSON.stringify({ pid: 0, ts: 1 }))
      expect(readHeartbeat(path)).toBeNull()
      writeFileSync(path, JSON.stringify({ pid: -1, ts: 1 }))
      expect(readHeartbeat(path)).toBeNull()
    })

    it('returns null when ts is non-positive', () => {
      writeFileSync(path, JSON.stringify({ pid: 1, ts: 0 }))
      expect(readHeartbeat(path)).toBeNull()
    })
  })

  describe('deleteHeartbeat', () => {
    it('removes an existing file', () => {
      writeHeartbeat(path, { pid: 1, ts: 1 })
      expect(existsSync(path)).toBe(true)
      deleteHeartbeat(path)
      expect(existsSync(path)).toBe(false)
    })

    it('is a no-op when the file is absent', () => {
      expect(() => deleteHeartbeat(path)).not.toThrow()
    })
  })

  describe('startHeartbeatWriter', () => {
    it('writes immediately on start (does not wait for first interval)', () => {
      const stop = startHeartbeatWriter({
        path,
        writeMs: 60_000,
        now: () => 1_700_000_000_000,
        pid: 42,
      })
      try {
        const rec = readHeartbeat(path)
        expect(rec).toEqual({ pid: 42, ts: 1_700_000_000_000 })
      } finally {
        stop()
      }
    })

    it('refreshes the file on every interval tick', async () => {
      let fakeNow = 1_700_000_000_000
      const stop = startHeartbeatWriter({
        path,
        writeMs: 20,
        now: () => fakeNow,
        pid: 99,
      })
      try {
        // First write happened synchronously at start
        expect(readHeartbeat(path)?.ts).toBe(1_700_000_000_000)

        // Advance fake clock and wait long enough for ≥1 interval tick
        fakeNow += 1_000
        await new Promise(r => setTimeout(r, 80))
        const after = readHeartbeat(path)
        expect(after?.ts).toBe(1_700_000_001_000)
        expect(after?.pid).toBe(99)
      } finally {
        stop()
      }
    })

    it('stop() clears the interval AND deletes the file', async () => {
      const stop = startHeartbeatWriter({
        path,
        writeMs: 20,
        pid: 7,
      })
      expect(existsSync(path)).toBe(true)
      stop()
      expect(existsSync(path)).toBe(false)

      // After stop, the interval must not write again — wait a few ticks and
      // confirm the file stays deleted.
      await new Promise(r => setTimeout(r, 80))
      expect(existsSync(path)).toBe(false)
    })

    it('defaults to process.pid and Date.now when not injected', () => {
      const before = Date.now()
      const stop = startHeartbeatWriter({ path, writeMs: 60_000 })
      try {
        const rec = readHeartbeat(path)
        expect(rec).not.toBeNull()
        expect(rec!.pid).toBe(process.pid)
        expect(rec!.ts).toBeGreaterThanOrEqual(before)
        expect(rec!.ts).toBeLessThanOrEqual(Date.now())
      } finally {
        stop()
      }
    })
  })

  describe('isPidAlive', () => {
    it('returns true for the current process', () => {
      expect(isPidAlive(process.pid)).toBe(true)
    })

    it('returns false for a PID that almost certainly does not exist', () => {
      // Max linux PID is typically 2^22; pid 2^31 - 1 is virtually impossible
      // to be a live process on a normal box and process.kill(pid, 0) returns ESRCH.
      expect(isPidAlive(2_147_483_646)).toBe(false)
    })

    it('returns false for non-positive or NaN pid', () => {
      expect(isPidAlive(0)).toBe(false)
      expect(isPidAlive(-1)).toBe(false)
      expect(isPidAlive(Number.NaN)).toBe(false)
    })
  })
})
