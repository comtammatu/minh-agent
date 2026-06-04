/**
 * Expectancy Gate Check — run walk-forward validation on real data.
 *
 * Usage: bun run src/backtest/run-gate-check.ts
 *
 * Steps:
 *   1. Download historical candles (if not already in PG)
 *   2. Load candles from PG
 *   3. Run walk-forward validation
 *   4. Print expectancy report
 *   5. Exit with code 0 (pass) or 1 (fail)
 *
 * Sprint 3 — Phase 3A gate check.
 */

import {
  BACKTEST_COMMISSION_PCT,
  BACKTEST_SLIPPAGE_PCT,
  WF_STEP_MS,
  WF_TEST_WINDOW_MS,
  WF_TRAIN_WINDOW_MS,
} from "../config.js";
import { sql } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { log } from "../lib/logger.js";
import { formatPipelineStats } from "../strategy/diagnostics.js";
import type { CandleInterval } from "../types.js";
import {
  BacktestDataManager,
  computeHTFIntervals,
  computeHTFWarmupMs,
} from "./data-manager.js";
import { runBacktest } from "./engine.js";
import { formatExpectancyReport, formatMetricsSummary } from "./report.js";
import type { BacktestConfig, WalkForwardConfig } from "./types.js";
import { walkForward } from "./walk-forward.js";

// ─── Configuration ─────────────────────────────────────────────────────────

/** Coins to validate. Top liquid coins on Hyperliquid by OI/volume. */
const GATE_COINS = [
  // Tier 1 — Majors
  "BTC",
  "ETH",
  "SOL",
  // Tier 2 — Large caps, liquid
  "DOGE",
  "AVAX",
  "LINK",
  "ARB",
  "SUI",
  // Tier 3 — Mid caps, volatile (more setups, more noise)
  "WLD",
  "INJ",
  "TIA",
  "SEI",
  "WIF",
  "PEPE",
  "ONDO",
];

/** Timeframes to validate. */
const GATE_TIMEFRAMES: CandleInterval[] = ["15m", "1h", "4h"];

/** How many months of history to use. 6 months for statistical significance (≥30 trades). */
const HISTORY_MONTHS = 6;

/** Initial capital for backtest. */
const INITIAL_CAPITAL = 10_000;

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  log.info("gate-check", "=== EXPECTANCY GATE CHECK ===");

  // Ensure DB is ready
  await runMigrations(sql);

  const dm = new BacktestDataManager();

  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - HISTORY_MONTHS);

  // Step 1: Download history (skips existing data via upsert)
  log.info(
    "gate-check",
    `Downloading ${HISTORY_MONTHS} months of history for ${GATE_COINS.join(", ")}...`,
  );

  // Determine extra HTF intervals needed for Layer 1 bias warmup
  const extraHTFs = computeHTFIntervals(GATE_TIMEFRAMES);
  if (extraHTFs.length > 0) {
    log.info(
      "gate-check",
      `Extra HTF intervals for bias warmup: ${extraHTFs.join(", ")}`,
    );
  }

  for (const coin of GATE_COINS) {
    // Download requested timeframes
    for (const tf of GATE_TIMEFRAMES) {
      const count = await dm.downloadHistory(coin, tf, startDate, endDate);
      log.info("gate-check", `${coin} ${tf}: ${count} candles`);
    }

    // Download extra HTF data with warmup buffer
    for (const htf of extraHTFs) {
      const warmupMs = computeHTFWarmupMs(htf);
      const htfStart = new Date(startDate.getTime() - warmupMs);
      const count = await dm.downloadHistory(coin, htf, htfStart, endDate);
      log.info("gate-check", `${coin} ${htf} (HTF warmup): ${count} candles`);
    }
  }

  // Step 2: Load candles
  log.info("gate-check", "Loading candles from PG...");
  const candles = await dm.loadForBacktest(
    GATE_COINS,
    GATE_TIMEFRAMES,
    startDate,
    endDate,
  );

  let totalCandles = 0;
  for (const [key, series] of candles) {
    totalCandles += series.length;
    log.info("gate-check", `${key}: ${series.length} candles`);
  }

  if (totalCandles === 0) {
    log.error(
      "gate-check",
      "No candle data loaded. Check DB connection and data availability.",
    );
    await sql.end();
    process.exit(1);
  }

  // Step 2.5: Diagnostic — single full-range backtest for per-layer stats
  log.info("gate-check", "Running diagnostic backtest (per-layer stats)...");

  const backtestConfig: BacktestConfig = {
    coins: GATE_COINS,
    timeframes: GATE_TIMEFRAMES,
    initialCapital: INITIAL_CAPITAL,
    slippagePct: BACKTEST_SLIPPAGE_PCT,
    commissionPct: BACKTEST_COMMISSION_PCT,
    strategy: "smc-sd",
    exitMode: "multi",
  };

  const diagResult = runBacktest(candles, backtestConfig);
  if (diagResult.pipelineStats) {
    console.log(`\n${formatPipelineStats(diagResult.pipelineStats)}`);

    // L5 rejection detail log
    const rejections = diagResult.pipelineStats.l5Rejections;
    if (rejections.length > 0) {
      console.log(`\n=== L5 REJECTION LOG (${rejections.length} events) ===`);
      for (const r of rejections) {
        const date = new Date(r.ts).toISOString().slice(0, 16);
        const patterns =
          r.patternsDetected.length > 0
            ? r.patternsDetected.join(", ")
            : "NONE";
        console.log(
          `  ${r.coin} ${r.interval} idx=${r.idx} ${date} | bias=${r.biasDir} confirmed=${r.confirmedCount} | patterns: ${patterns}`,
        );
      }
      console.log("==========================================");
    }
  }
  log.info(
    "gate-check",
    `Diagnostic: ${diagResult.trades.length} trades on full dataset`,
  );

  // Trade detail log — TP/SL distance analysis
  if (diagResult.trades.length > 0) {
    console.log(`\n=== TRADE DETAIL (${diagResult.trades.length} trades) ===`);
    console.log(
      "  Coin    TF    Side   Entry       SL          TP          SL%     TP%     R:R    PnL      Exit     Bars",
    );
    for (const t of diagResult.trades) {
      const slPct = (Math.abs(t.entryPrice - t.slPrice) / t.entryPrice) * 100;
      const tpPct = (Math.abs(t.tpPrice - t.entryPrice) / t.entryPrice) * 100;
      const rr = slPct > 0 ? tpPct / slPct : 0;
      const fmt = (n: number) =>
        n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
      console.log(
        `  ${t.coin.padEnd(7)} ${t.interval.padEnd(5)} ${t.side.padEnd(6)} ${fmt(t.entryPrice).padEnd(11)} ${fmt(t.slPrice).padEnd(11)} ${fmt(t.tpPrice).padEnd(11)} ${slPct.toFixed(2).padStart(5)}%  ${tpPct.toFixed(2).padStart(5)}%  ${rr.toFixed(2).padStart(4)}  ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2).padStart(8)}  ${t.exitReason.padEnd(8)} ${t.holdingBars}`,
      );
    }
    // Summary stats
    const slPcts = diagResult.trades.map(
      (t) => (Math.abs(t.entryPrice - t.slPrice) / t.entryPrice) * 100,
    );
    const tpPcts = diagResult.trades.map(
      (t) => (Math.abs(t.tpPrice - t.entryPrice) / t.entryPrice) * 100,
    );
    const rrs = slPcts.map((sl, i) => (sl > 0 ? tpPcts[i]! / sl : 0));
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    console.log(
      `  ───────────────────────────────────────────────────────────────────────────────────────`,
    );
    console.log(
      `  AVG SL%: ${avg(slPcts).toFixed(2)}%  |  AVG TP%: ${avg(tpPcts).toFixed(2)}%  |  AVG R:R: ${avg(rrs).toFixed(2)}  |  AVG PnL: $${avg(diagResult.trades.map((t) => t.pnl)).toFixed(2)}`,
    );

    // Partial close breakdown
    const withPartials = diagResult.trades.filter(
      (t) => t.partialCloses && t.partialCloses.length > 0,
    );
    if (withPartials.length > 0) {
      const allPartials = withPartials.flatMap((t) => t.partialCloses!);
      const byReason = new Map<string, number>();
      for (const p of allPartials)
        byReason.set(p.reason, (byReason.get(p.reason) ?? 0) + 1);
      console.log(
        `  Partial closes: ${allPartials.length} across ${withPartials.length} trades`,
      );
      for (const [reason, count] of byReason)
        console.log(`    ${reason}: ${count}`);
    }
    console.log("==========================================");
  }

  // Step 3: Run walk-forward
  log.info("gate-check", "Running walk-forward validation...");

  const wfConfig: WalkForwardConfig = {
    backtestConfig,
    trainWindowMs: WF_TRAIN_WINDOW_MS,
    testWindowMs: WF_TEST_WINDOW_MS,
    stepMs: WF_STEP_MS,
  };

  const result = walkForward(candles, wfConfig);

  // Step 4: Print report
  const report = formatExpectancyReport(result);
  console.log(`\n${report}`);

  // Also print one-line summaries
  console.log(`\n${formatMetricsSummary(result.isMetrics, "IS")}`);
  console.log(formatMetricsSummary(result.oosMetrics, "OOS"));

  // Step 5: Gate verdict
  if (result.passesGate) {
    log.info(
      "gate-check",
      "GATE PASSED — OOS expectancy > 0. Proceed to Phase 3B.",
    );
  } else {
    log.warn(
      "gate-check",
      "GATE FAILED — OOS expectancy <= 0. Fix pipeline before proceeding.",
    );
  }

  // Cleanup
  await sql.end();

  process.exit(result.passesGate ? 0 : 1);
}

main().catch((err) => {
  log.error(
    "gate-check",
    `Fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  sql.end().catch(() => {});
  process.exit(1);
});
