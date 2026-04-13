import { describe, expect, test } from 'bun:test'
import { evaluateRegression, selectBudgetMetrics } from '../../src/backtest/performance-budget.js'

describe('performance-budget helpers', () => {
  test('selectBudgetMetrics prefers robust when requested', () => {
    const metrics = selectBudgetMetrics({
      aggregate: {
        latencyRaw: { count: 1, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 2, p99Ms: 3 },
        latencyRobust: { count: 1, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 1, p99Ms: 2 },
      },
    }, 'robust')
    expect(metrics.p95Ms).toBe(1)
    expect(metrics.p99Ms).toBe(2)
  })

  test('selectBudgetMetrics falls back to raw when robust missing', () => {
    const metrics = selectBudgetMetrics({
      aggregate: {
        latencyRaw: { count: 1, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 4, p99Ms: 5 },
      },
    }, 'robust')
    expect(metrics).toEqual({ p95Ms: 4, p99Ms: 5 })
  })

  test('evaluateRegression marks fail when regression exceeds budget', () => {
    const result = evaluateRegression(
      { p95Ms: 10, p99Ms: 20 },
      { p95Ms: 11.2, p99Ms: 21.9 },
      { p95Pct: 0.10, p99Pct: 0.10 },
    )
    expect(result.p95.pass).toBe(false)
    expect(result.p99.pass).toBe(true)
    expect(result.pass).toBe(false)
  })
})
