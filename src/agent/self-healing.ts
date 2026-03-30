/**
 * Self-Healing — health aggregator + RSS monitor (S13).
 *
 * Tracks component health (feed, DB, exchange) and memory usage.
 * Provides aggregated health report for /api/health endpoint.
 * Does NOT take control actions — reports status for humans/agent to react.
 *
 * Design:
 *   - Singleton — call getHealthMonitor()
 *   - Components call recordSuccess/recordError to update their health
 *   - Periodic check updates RSS + computes overall status
 *   - /api/health reads getReport() for full picture
 */

import type { ComponentHealth, ComponentStatus, HealthReport } from './types.js'
import { HEALTH } from '../config.js'
import { log } from '../lib/logger.js'

// ─── Component Health Tracker ───────────────────────────────────────────────

function makeHealth(): ComponentHealth {
  return {
    status: 'ok',
    lastSuccessAt: Date.now(),
    lastErrorAt: 0,
    lastError: null,
    consecutiveErrors: 0,
  }
}

/**
 * Determine component status from its health state.
 * Pure function — no side effects.
 */
export function computeComponentStatus(
  health: ComponentHealth,
  staleThresholdMs: number,
  now: number,
): ComponentStatus {
  // 5+ consecutive errors → critical
  if (health.consecutiveErrors >= 5) return 'critical'
  // 3+ consecutive errors → degraded
  if (health.consecutiveErrors >= 3) return 'degraded'
  // Stale (no success within threshold) → degraded
  if (now - health.lastSuccessAt > staleThresholdMs) return 'degraded'
  return 'ok'
}

/**
 * Compute overall status from component statuses.
 * Pure function — any critical → critical, any degraded → degraded, else ok.
 */
export function computeOverallStatus(statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.some(s => s === 'critical')) return 'critical'
  if (statuses.some(s => s === 'degraded')) return 'degraded'
  return 'ok'
}

/**
 * Compute memory status from RSS bytes.
 * Pure function.
 */
export function computeMemoryStatus(rssBytes: number): ComponentStatus {
  if (rssBytes >= HEALTH.rssCriticalBytes) return 'critical'
  if (rssBytes >= HEALTH.rssWarnBytes) return 'degraded'
  return 'ok'
}

// ─── Health Monitor ─────────────────────────────────────────────────────────

export type ComponentName = 'feed' | 'db' | 'exchange'

export class HealthMonitor {
  private components: Record<ComponentName, ComponentHealth>
  private startedAt: number
  private checkTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.startedAt = Date.now()
    this.components = {
      feed: makeHealth(),
      db: makeHealth(),
      exchange: makeHealth(),
    }
  }

  /** Record a successful operation for a component. */
  recordSuccess(component: ComponentName): void {
    const h = this.components[component]
    h.lastSuccessAt = Date.now()
    h.consecutiveErrors = 0
    h.status = 'ok'
  }

  /** Record an error for a component. */
  recordError(component: ComponentName, error: string): void {
    const h = this.components[component]
    h.lastErrorAt = Date.now()
    h.lastError = error
    h.consecutiveErrors++
    // Recompute status immediately
    const staleMs = component === 'exchange' ? HEALTH.exchangeStaleMs : HEALTH.dbStaleMs
    h.status = computeComponentStatus(h, staleMs, Date.now())
  }

  /** Get full health report. */
  getReport(): HealthReport {
    const now = Date.now()
    const rssBytes = process.memoryUsage?.().rss ?? 0

    // Update component statuses based on staleness
    for (const [name, health] of Object.entries(this.components)) {
      const staleMs = name === 'exchange' ? HEALTH.exchangeStaleMs : HEALTH.dbStaleMs
      health.status = computeComponentStatus(health, staleMs, now)
    }

    const memoryStatus = computeMemoryStatus(rssBytes)
    const componentStatuses = Object.values(this.components).map(h => h.status)
    const overall = computeOverallStatus([...componentStatuses, memoryStatus])

    return {
      overall,
      uptime: Math.floor((now - this.startedAt) / 1000),
      rssBytes,
      components: { ...this.components },
    }
  }

  /** Get a single component's health. */
  getComponentHealth(component: ComponentName): ComponentHealth {
    return { ...this.components[component] }
  }

  /** Start periodic health check (logs warnings for degraded/critical). */
  startPeriodicCheck(): void {
    if (this.checkTimer) return
    this.checkTimer = setInterval(() => {
      const report = this.getReport()

      if (report.overall === 'critical') {
        log.error('health', `CRITICAL — overall=${report.overall} rss=${formatBytes(report.rssBytes)}`)
        for (const [name, h] of Object.entries(report.components)) {
          if (h.status === 'critical') {
            log.error('health', `  ${name}: ${h.status} errors=${h.consecutiveErrors} lastErr=${h.lastError ?? 'none'}`)
          }
        }
      } else if (report.overall === 'degraded') {
        log.warn('health', `DEGRADED — rss=${formatBytes(report.rssBytes)}`)
        for (const [name, h] of Object.entries(report.components)) {
          if (h.status !== 'ok') {
            log.warn('health', `  ${name}: ${h.status} errors=${h.consecutiveErrors}`)
          }
        }
      }

      // RSS warnings
      const memStatus = computeMemoryStatus(report.rssBytes)
      if (memStatus === 'critical') {
        log.error('health', `RSS CRITICAL: ${formatBytes(report.rssBytes)} — consider restart`)
      } else if (memStatus === 'degraded') {
        log.warn('health', `RSS WARNING: ${formatBytes(report.rssBytes)}`)
      }
    }, HEALTH.checkIntervalMs)
  }

  /** Stop periodic check. */
  stopPeriodicCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / 1024).toFixed(1)}KB`
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: HealthMonitor | null = null

export function getHealthMonitor(): HealthMonitor {
  if (!instance) {
    instance = new HealthMonitor()
  }
  return instance
}

/** Reset singleton (tests only). */
export function resetHealthMonitor(): void {
  instance?.stopPeriodicCheck()
  instance = null
}
