import type { PipelineBenchmarkMetricMode } from "../config.js";
import type { LatencyStats } from "./pipeline-benchmark.js";

export interface BenchmarkAggregateLike {
  latencyRaw?: LatencyStats;
  latencyRobust?: LatencyStats;
  latency?: LatencyStats;
}

export interface BenchmarkResultLike {
  aggregate: BenchmarkAggregateLike;
}

export interface MetricPair {
  p95Ms: number;
  p99Ms: number;
}

export interface RegressionThresholds {
  p95Pct: number;
  p99Pct: number;
}

export interface RegressionSide {
  baselineMs: number;
  currentMs: number;
  allowedMs: number;
  regressionPct: number;
  pass: boolean;
}

export interface RegressionCheck {
  pass: boolean;
  p95: RegressionSide;
  p99: RegressionSide;
}

export function selectBudgetMetrics(
  result: BenchmarkResultLike,
  mode: PipelineBenchmarkMetricMode,
): MetricPair {
  const raw = result.aggregate.latencyRaw ?? result.aggregate.latency;
  const robust = result.aggregate.latencyRobust;

  if (mode === "robust" && robust) {
    return { p95Ms: robust.p95Ms, p99Ms: robust.p99Ms };
  }
  if (raw) {
    return { p95Ms: raw.p95Ms, p99Ms: raw.p99Ms };
  }
  throw new Error("Benchmark result is missing latency metrics");
}

export function evaluateRegression(
  baseline: MetricPair,
  current: MetricPair,
  thresholds: RegressionThresholds,
): RegressionCheck {
  const p95 = evaluateSide(baseline.p95Ms, current.p95Ms, thresholds.p95Pct);
  const p99 = evaluateSide(baseline.p99Ms, current.p99Ms, thresholds.p99Pct);
  return {
    pass: p95.pass && p99.pass,
    p95,
    p99,
  };
}

function evaluateSide(
  baselineMs: number,
  currentMs: number,
  maxRegressionPct: number,
): RegressionSide {
  const safeBaseline = baselineMs > 0 ? baselineMs : Number.EPSILON;
  const safeThreshold = maxRegressionPct >= 0 ? maxRegressionPct : 0;
  const allowedMs = safeBaseline * (1 + safeThreshold);
  const regressionPct = (currentMs - safeBaseline) / safeBaseline;

  return {
    baselineMs,
    currentMs,
    allowedMs,
    regressionPct,
    pass: currentMs <= allowedMs,
  };
}
