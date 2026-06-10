/**
 * CI performance budget gate for pipeline latency.
 *
 * Runs benchmark with fixed CI config, compares p95/p99 against baseline,
 * and exits non-zero on regression above budget.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BenchmarkResultLike,
  evaluateRegression,
  type MetricPair,
  selectBudgetMetrics,
} from "../src/backtest/performance-budget.js";
import {
  PIPELINE_BENCH_CI_BARS_PER_SERIES,
  PIPELINE_BENCH_CI_BASELINE_PATH,
  PIPELINE_BENCH_CI_COINS,
  PIPELINE_BENCH_CI_MAX_REGRESSION,
  PIPELINE_BENCH_CI_MEASURED_RUNS,
  PIPELINE_BENCH_CI_METRIC_MODE,
  PIPELINE_BENCH_CI_TIMEFRAMES,
  PIPELINE_BENCH_CI_TRIM_RATIO,
  PIPELINE_BENCH_CI_WARMUP_RUNS,
  type PipelineBenchmarkMetricMode,
} from "../src/config.js";

interface PerformanceBaselineFile {
  generatedAt: string;
  sourceResult: string;
  metrics: {
    raw: MetricPair;
    robust: MetricPair;
  };
}

const CI_OUTPUT_PATH = "results/ci/pipeline-benchmark-current.json";

async function main(): Promise<void> {
  const baselinePath = resolve(
    process.cwd(),
    process.env.PIPELINE_BENCH_BASELINE_PATH ?? PIPELINE_BENCH_CI_BASELINE_PATH,
  );
  const mode = getMetricMode();
  const p95BudgetPct = parsePctEnv(
    "PIPELINE_BENCH_MAX_REGRESSION_P95_PCT",
    PIPELINE_BENCH_CI_MAX_REGRESSION.p95Pct,
  );
  const p99BudgetPct = parsePctEnv(
    "PIPELINE_BENCH_MAX_REGRESSION_P99_PCT",
    PIPELINE_BENCH_CI_MAX_REGRESSION.p99Pct,
  );

  const baseline = await readBaseline(baselinePath);
  const currentPath = resolve(process.cwd(), CI_OUTPUT_PATH);

  const args = [
    "run",
    "scripts/backtest/run-pipeline-benchmark.ts",
    "--coins",
    PIPELINE_BENCH_CI_COINS.join(","),
    "--tfs",
    PIPELINE_BENCH_CI_TIMEFRAMES.join(","),
    "--bars",
    String(PIPELINE_BENCH_CI_BARS_PER_SERIES),
    "--warmup",
    String(PIPELINE_BENCH_CI_WARMUP_RUNS),
    "--runs",
    String(PIPELINE_BENCH_CI_MEASURED_RUNS),
    "--trim",
    String(PIPELINE_BENCH_CI_TRIM_RATIO),
    "--out",
    currentPath,
  ];

  console.log("=".repeat(70));
  console.log(" PIPELINE PERFORMANCE BUDGET CHECK");
  console.log("=".repeat(70));
  console.log(` Baseline: ${baselinePath}`);
  console.log(` Mode:     ${mode}`);
  console.log(
    ` Budget:   p95<=${(p95BudgetPct * 100).toFixed(1)}% p99<=${(p99BudgetPct * 100).toFixed(1)}% regression`,
  );
  console.log("-".repeat(70));

  const runCode = await runBun(args);
  if (runCode !== 0) {
    throw new Error(`Benchmark execution failed with exit code ${runCode}`);
  }

  const currentResult = await readBenchmarkResult(currentPath);
  const baselineMetrics =
    mode === "robust" ? baseline.metrics.robust : baseline.metrics.raw;
  const currentMetrics = selectBudgetMetrics(currentResult, mode);
  const regression = evaluateRegression(baselineMetrics, currentMetrics, {
    p95Pct: p95BudgetPct,
    p99Pct: p99BudgetPct,
  });

  printSide("p95", regression.p95);
  printSide("p99", regression.p99);
  console.log("-".repeat(70));

  if (!regression.pass) {
    console.error("❌ Pipeline performance budget FAILED");
    process.exit(1);
  }

  console.log("✅ Pipeline performance budget PASSED");
}

function printSide(
  label: "p95" | "p99",
  side: ReturnType<typeof evaluateRegression>["p95"],
): void {
  const sign = side.regressionPct >= 0 ? "+" : "";
  console.log(
    ` ${label} | baseline=${fmtMs(side.baselineMs)} current=${fmtMs(side.currentMs)} ` +
      `allowed=${fmtMs(side.allowedMs)} delta=${sign}${(side.regressionPct * 100).toFixed(2)}% ` +
      `| ${side.pass ? "PASS" : "FAIL"}`,
  );
}

function fmtMs(v: number): string {
  return `${v.toFixed(4)}ms`;
}

async function readBaseline(path: string): Promise<PerformanceBaselineFile> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PerformanceBaselineFile;
}

async function readBenchmarkResult(path: string): Promise<BenchmarkResultLike> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as BenchmarkResultLike;
}

function getMetricMode(): PipelineBenchmarkMetricMode {
  const env = process.env.PIPELINE_BENCH_CI_MODE;
  if (env === "raw" || env === "robust") return env;
  return PIPELINE_BENCH_CI_METRIC_MODE;
}

function parsePctEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

async function runBun(args: string[]): Promise<number> {
  const proc = Bun.spawn(["bun", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      LOG_LEVEL: process.env.LOG_LEVEL ?? "ERROR",
    },
  });
  return await proc.exited;
}

await main();
