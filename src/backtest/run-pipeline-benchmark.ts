/**
 * Pipeline latency benchmark runner.
 *
 * Measures per-tick latency of `onCandleTick` using synthetic candles,
 * reporting p50/p95/p99 and throughput across multiple runs.
 *
 * Usage:
 *   bun run src/backtest/run-pipeline-benchmark.ts
 *   bun run src/backtest/run-pipeline-benchmark.ts --coins BTC,ETH,SOL --tfs 5m,15m,1h,4h --bars 1500 --warmup 2 --runs 9 --trim 0.01 --save
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CandleInterval } from "../types.js";
import {
  buildReplayEvents,
  generateSyntheticCandles,
  type LatencyStats,
  parseBenchmarkArgs,
  type ReplayEvent,
  summarizeLatency,
  trimOutliers,
} from "./pipeline-benchmark.js";

process.env.LOG_LEVEL ??= "ERROR";

interface RunSummary {
  runIndex: number;
  totalTicks: number;
  elapsedMs: number;
  throughputTicksPerSec: number;
  latency: LatencyStats;
}

interface BenchmarkOutput {
  generatedAt: string;
  options: {
    coins: string[];
    timeframes: CandleInterval[];
    barsPerSeries: number;
    warmupRuns: number;
    measuredRuns: number;
    outlierTrimRatio: number;
    outputPath: string | null;
    seed: number;
  };
  dataset: {
    series: number;
    eventsPerRun: number;
    totalMeasuredTicks: number;
  };
  aggregate: {
    elapsedMs: number;
    throughputTicksPerSec: number;
    latencyRaw: LatencyStats;
    latencyRobust: LatencyStats;
    droppedOutlierSamples: number;
  };
  byIntervalRaw: Record<string, LatencyStats>;
  byIntervalRobust: Record<string, LatencyStats>;
  runs: RunSummary[];
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2));

  const [
    { onCandleTick, clearPipelineState, setActiveStrategyParams },
    { clearSetupGeneratorState, resetSetupGenerator },
    { clearStore, clearOnPersist },
  ] = await Promise.all([
    import("../strategy/orchestrator.js"),
    import("../strategy/engine.js"),
    import("../feed/store.js"),
  ]);

  resetSetupGenerator();
  clearSetupGeneratorState();

  const candleMap = generateSyntheticCandles(
    options.coins,
    options.timeframes,
    options.barsPerSeries,
    options.seed,
  );

  const replayEvents = buildReplayEvents(
    candleMap,
    options.coins,
    options.timeframes,
  );
  if (replayEvents.length === 0) {
    console.error("No replay events generated. Check --coins/--tfs args.");
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log(" PIPELINE BENCHMARK (onCandleTick latency)");
  console.log("=".repeat(70));
  console.log(` Coins:      ${options.coins.join(", ")}`);
  console.log(` Timeframes: ${options.timeframes.join(", ")}`);
  console.log(` Bars/series:${options.barsPerSeries}`);
  console.log(` Events/run: ${replayEvents.length}`);
  console.log(` Warmup:     ${options.warmupRuns}`);
  console.log(` Measured:   ${options.measuredRuns}`);
  console.log(
    ` Trim tail:  ${(options.outlierTrimRatio * 100).toFixed(2)}% per side`,
  );
  console.log(` Seed:       ${options.seed}`);

  // Warmup
  for (let i = 0; i < options.warmupRuns; i++) {
    runReplay(
      replayEvents,
      onCandleTick,
      clearPipelineState,
      clearStore,
      clearOnPersist,
      clearSetupGeneratorState,
      setActiveStrategyParams,
      null,
    );
  }

  // Measured runs
  const allDurations: number[] = [];
  const byIntervalDurations = new Map<CandleInterval, number[]>();
  const runSummaries: RunSummary[] = [];

  const measuredStart = performance.now();

  for (let run = 0; run < options.measuredRuns; run++) {
    const runDurations: number[] = [];
    const runElapsedMs = runReplay(
      replayEvents,
      onCandleTick,
      clearPipelineState,
      clearStore,
      clearOnPersist,
      clearSetupGeneratorState,
      setActiveStrategyParams,
      { runDurations, byIntervalDurations },
    );

    allDurations.push(...runDurations);

    const runLatency = summarizeLatency(runDurations);
    runSummaries.push({
      runIndex: run + 1,
      totalTicks: runDurations.length,
      elapsedMs: runElapsedMs,
      throughputTicksPerSec: (runDurations.length / runElapsedMs) * 1000,
      latency: runLatency,
    });

    console.log(
      ` Run ${String(run + 1).padStart(2)} | ` +
        `p50=${fmtMs(runLatency.p50Ms)} p95=${fmtMs(runLatency.p95Ms)} p99=${fmtMs(runLatency.p99Ms)} ` +
        `max=${fmtMs(runLatency.maxMs)} | throughput=${((runDurations.length / runElapsedMs) * 1000).toFixed(0)} tick/s`,
    );
  }

  const measuredElapsedMs = performance.now() - measuredStart;

  const aggregateLatencyRaw = summarizeLatency(allDurations);
  const aggregateTrimmed = trimOutliers(allDurations, options.outlierTrimRatio);
  const aggregateLatencyRobust = summarizeLatency(aggregateTrimmed);
  const droppedOutlierSamples = allDurations.length - aggregateTrimmed.length;
  const aggregateThroughput = (allDurations.length / measuredElapsedMs) * 1000;

  const byIntervalRaw: Record<string, LatencyStats> = {};
  const byIntervalRobust: Record<string, LatencyStats> = {};
  for (const [interval, values] of byIntervalDurations) {
    byIntervalRaw[interval] = summarizeLatency(values);
    byIntervalRobust[interval] = summarizeLatency(
      trimOutliers(values, options.outlierTrimRatio),
    );
  }

  console.log("-".repeat(70));
  console.log(
    ` Aggregate | p50=${fmtMs(aggregateLatencyRaw.p50Ms)} p95=${fmtMs(aggregateLatencyRaw.p95Ms)} ` +
      `p99=${fmtMs(aggregateLatencyRaw.p99Ms)} max=${fmtMs(aggregateLatencyRaw.maxMs)} ` +
      `| throughput=${aggregateThroughput.toFixed(0)} tick/s`,
  );
  console.log(
    ` Robust    | p50=${fmtMs(aggregateLatencyRobust.p50Ms)} p95=${fmtMs(aggregateLatencyRobust.p95Ms)} ` +
      `p99=${fmtMs(aggregateLatencyRobust.p99Ms)} max=${fmtMs(aggregateLatencyRobust.maxMs)} ` +
      `| kept=${aggregateTrimmed.length}/${allDurations.length}`,
  );

  for (const interval of options.timeframes) {
    const raw = byIntervalRaw[interval];
    const robust = byIntervalRobust[interval];
    if (!raw || !robust) continue;
    console.log(
      `   ${interval.padEnd(3)} | raw p95=${fmtMs(raw.p95Ms)} p99=${fmtMs(raw.p99Ms)} ` +
        `| robust p95=${fmtMs(robust.p95Ms)} p99=${fmtMs(robust.p99Ms)} | n=${raw.count}`,
    );
  }

  const output: BenchmarkOutput = {
    generatedAt: new Date().toISOString(),
    options: {
      coins: [...options.coins],
      timeframes: [...options.timeframes],
      barsPerSeries: options.barsPerSeries,
      warmupRuns: options.warmupRuns,
      measuredRuns: options.measuredRuns,
      outlierTrimRatio: options.outlierTrimRatio,
      outputPath: options.outputPath,
      seed: options.seed,
    },
    dataset: {
      series: options.coins.length * options.timeframes.length,
      eventsPerRun: replayEvents.length,
      totalMeasuredTicks: allDurations.length,
    },
    aggregate: {
      elapsedMs: measuredElapsedMs,
      throughputTicksPerSec: aggregateThroughput,
      latencyRaw: aggregateLatencyRaw,
      latencyRobust: aggregateLatencyRobust,
      droppedOutlierSamples,
    },
    byIntervalRaw,
    byIntervalRobust,
    runs: runSummaries,
  };

  const shouldPersist = options.saveResult || options.outputPath !== null;
  if (shouldPersist) {
    const outPath =
      options.outputPath !== null
        ? resolve(process.cwd(), options.outputPath)
        : join(
            process.cwd(),
            "results",
            `pipeline-benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
          );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");
    console.log(` Saved: ${outPath}`);
  }

  // Cleanup so this runner doesn't leak singleton state if reused in-process.
  clearPipelineState();
  clearStore();
  clearOnPersist();
  setActiveStrategyParams(null);

  console.log("=".repeat(70));
}

function runReplay(
  replayEvents: readonly ReplayEvent[],
  onCandleTick: (
    coin: string,
    interval: CandleInterval,
    candle: ReplayEvent["candle"],
  ) => void,
  clearPipelineState: () => void,
  clearStore: () => void,
  clearOnPersist: () => void,
  clearSetupGeneratorState: () => void,
  setActiveStrategyParams: (params: null) => void,
  collector: {
    runDurations: number[];
    byIntervalDurations: Map<CandleInterval, number[]>;
  } | null,
): number {
  clearPipelineState();
  clearStore();
  clearOnPersist();
  clearSetupGeneratorState();
  setActiveStrategyParams(null);

  const runStart = performance.now();

  for (const event of replayEvents) {
    const t0 = performance.now();
    onCandleTick(event.coin, event.interval, event.candle);
    const dt = performance.now() - t0;

    if (collector) {
      collector.runDurations.push(dt);
      const arr = collector.byIntervalDurations.get(event.interval) ?? [];
      arr.push(dt);
      collector.byIntervalDurations.set(event.interval, arr);
    }
  }

  return performance.now() - runStart;
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(4)}ms`;
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Benchmark failed: ${msg}`);
  process.exit(1);
});
