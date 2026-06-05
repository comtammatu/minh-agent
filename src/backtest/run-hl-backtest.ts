/**
 * Hyperliquid Comprehensive Backtest — 15 coins × 4 TFs × ~3 months.
 *
 * Usage: bun run src/backtest/run-hl-backtest.ts [smc-sd]
 * Legacy alias `all` is accepted and maps to `smc-sd`.
 *
 * Mirrors the Bybit runner but uses HL REST feed.
 * No PostgreSQL required — all data fetched directly into memory.
 */

import {
  BACKTEST_SLIPPAGE_PCT,
  HTF_MAP,
  WF_STEP_MS,
  WF_TEST_WINDOW_MS,
  WF_TRAIN_WINDOW_MS,
} from "../config.js";
import { fetchCandlesBatched } from "../feed/rest.js";
import { log } from "../lib/logger.js";
import { formatPipelineStats } from "../strategy/diagnostics.js";
import type { Candle, CandleInterval } from "../types.js";
import { runBacktest } from "./engine.js";
import { formatExpectancyReport, formatMetricsSummary } from "./report.js";
import type {
  BacktestConfig,
  StrategyType,
  WalkForwardConfig,
} from "./types.js";
import { walkForward } from "./walk-forward.js";

// ─── Configuration ─────────────────────────────────────────────────────────

/** Top liquid HL perps — matches Bybit list where possible.
 *  HYPE replaces BNB (HL native token). */
const COINS = [
  "BTC",
  "ETH",
  "SOL",
  "HYPE",
  "XRP",
  "DOGE",
  "AVAX",
  "LINK",
  "ARB",
  "SUI",
  "WLD",
  "INJ",
  "TIA",
  "SEI",
  "ONDO",
];

/** Timeframes: 4h POI → 15m confirm → 5m micro-entry + 1h same-TF. */
const TIMEFRAMES: CandleInterval[] = ["5m", "15m", "1h", "4h"];

/** Candle counts per TF.
 * HL max 5000/request, fetched in 500-candle batches.
 * 3 months coverage:
 *   5m: 90d × 288 = 25920 → capped at 5000 (~17d, enough for drill-down)
 *   15m: 90d × 96 = 8640 → capped at 5000 (~52d)
 *   1h: 90d × 24 = 2160 → fetch 2500 for buffer
 *   4h: 90d × 6 = 540 → fetch 1000 for buffer */
const CANDLE_COUNTS: Record<CandleInterval, number> = {
  "1m": 500,
  "5m": 5000,
  "15m": 5000,
  "1h": 2500,
  "4h": 1000,
  "1d": 500,
};

/** HTF warmup candles for Layer 1 bias. */
const HTF_WARMUP_CANDLES = 50;

/** Initial capital for backtest (USD). */
const INITIAL_CAPITAL = 10_000;

/** HL taker fee = 0.03% (lower than Bybit's 0.055%). */
const HL_COMMISSION_PCT = 0.0003;

// ─── Helpers ───────────────────────────────────────────────────────────────

function computeExtraHTFs(tfs: CandleInterval[]): CandleInterval[] {
  const set = new Set(tfs);
  const extras = new Set<CandleInterval>();
  for (const tf of tfs) {
    const htf = HTF_MAP[tf];
    if (htf !== tf && !set.has(htf)) extras.add(htf);
  }
  return [...extras];
}

async function fetchAllCandles(
  coins: string[],
  tfs: CandleInterval[],
  extraHTFs: CandleInterval[],
): Promise<Map<string, Candle[]>> {
  const result = new Map<string, Candle[]>();
  const allTFs = [...tfs, ...extraHTFs];
  const total = coins.length * allTFs.length;
  let done = 0;

  for (const coin of coins) {
    for (const tf of allTFs) {
      const count = CANDLE_COUNTS[tf] ?? 5000;
      const isHTF = extraHTFs.includes(tf);
      const fetchCount = isHTF ? count + HTF_WARMUP_CANDLES : count;

      const candles = await fetchCandlesBatched(coin, tf, fetchCount);
      done++;

      if (candles === null || candles.length === 0) {
        log.warn(
          "hl-backtest",
          `[${done}/${total}] ${coin} ${tf}: FAILED — skipping`,
        );
        continue;
      }

      result.set(`${coin}|${tf}`, candles);
      const dateRange = `${new Date(candles[0]!.t).toISOString().slice(0, 10)} → ${new Date(candles.at(-1)!.t).toISOString().slice(0, 10)}`;
      log.info(
        "hl-backtest",
        `[${done}/${total}] ${coin} ${tf}: ${candles.length} candles (${dateRange})`,
      );
    }
  }

  return result;
}

function printTradeDetails(trades: import("./types.js").BacktestTrade[]): void {
  if (trades.length === 0) return;

  console.log(`\n=== TRADE DETAIL (${trades.length} trades) ===`);
  console.log(
    "  Coin    TF    Side   Entry       SL          TP          SL%     TP%     R:R    PnL      Exit     Bars",
  );

  for (const t of trades) {
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
  const slPcts = trades.map(
    (t) => (Math.abs(t.entryPrice - t.slPrice) / t.entryPrice) * 100,
  );
  const tpPcts = trades.map(
    (t) => (Math.abs(t.tpPrice - t.entryPrice) / t.entryPrice) * 100,
  );
  const rrs = slPcts.map((sl, i) => (sl > 0 ? tpPcts[i]! / sl : 0));
  const avg = (arr: number[]) =>
    arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;

  console.log(
    "  ───────────────────────────────────────────────────────────────────────────────────────",
  );
  console.log(
    `  AVG SL%: ${avg(slPcts).toFixed(2)}%  |  AVG TP%: ${avg(tpPcts).toFixed(2)}%  |  AVG R:R: ${avg(rrs).toFixed(2)}  |  AVG PnL: $${avg(trades.map((t) => t.pnl)).toFixed(2)}`,
  );

  // Breakdown by exit reason
  const byExit = new Map<string, { count: number; pnl: number }>();
  for (const t of trades) {
    const e = byExit.get(t.exitReason) ?? { count: 0, pnl: 0 };
    e.count++;
    e.pnl += t.pnl;
    byExit.set(t.exitReason, e);
  }
  console.log("\n  Exit reason breakdown:");
  for (const [reason, { count, pnl }] of [...byExit.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    console.log(
      `    ${reason.padEnd(15)} ${String(count).padStart(3)} trades  PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    );
  }

  // Breakdown by coin
  const byCoin = new Map<
    string,
    { count: number; pnl: number; wins: number }
  >();
  for (const t of trades) {
    const c = byCoin.get(t.coin) ?? { count: 0, pnl: 0, wins: 0 };
    c.count++;
    c.pnl += t.pnl;
    if (t.pnl > 0) c.wins++;
    byCoin.set(t.coin, c);
  }
  console.log("\n  Per-coin breakdown:");
  for (const [coin, { count, pnl, wins }] of [...byCoin.entries()].sort(
    (a, b) => b[1].pnl - a[1].pnl,
  )) {
    const wr = count > 0 ? ((wins / count) * 100).toFixed(0) : "0";
    console.log(
      `    ${coin.padEnd(7)} ${String(count).padStart(3)} trades  WR: ${wr.padStart(3)}%  PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    );
  }

  // Breakdown by timeframe
  const byTF = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const t of trades) {
    const tf = byTF.get(t.interval) ?? { count: 0, pnl: 0, wins: 0 };
    tf.count++;
    tf.pnl += t.pnl;
    if (t.pnl > 0) tf.wins++;
    byTF.set(t.interval, tf);
  }
  console.log("\n  Per-TF breakdown:");
  for (const [tf, { count, pnl, wins }] of [...byTF.entries()].sort(
    (a, b) => b[1].pnl - a[1].pnl,
  )) {
    const wr = count > 0 ? ((wins / count) * 100).toFixed(0) : "0";
    console.log(
      `    ${tf.padEnd(5)} ${String(count).padStart(3)} trades  WR: ${wr.padStart(3)}%  PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    );
  }

  // Breakdown by side
  const bySide = new Map<
    string,
    { count: number; pnl: number; wins: number }
  >();
  for (const t of trades) {
    const s = bySide.get(t.side) ?? { count: 0, pnl: 0, wins: 0 };
    s.count++;
    s.pnl += t.pnl;
    if (t.pnl > 0) s.wins++;
    bySide.set(t.side, s);
  }
  console.log("\n  Long vs Short:");
  for (const [side, { count, pnl, wins }] of bySide) {
    const wr = count > 0 ? ((wins / count) * 100).toFixed(0) : "0";
    console.log(
      `    ${side.padEnd(6)} ${String(count).padStart(3)} trades  WR: ${wr.padStart(3)}%  PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    );
  }

  // Partial close stats
  const withPartials = trades.filter(
    (t) => t.partialCloses && t.partialCloses.length > 0,
  );
  if (withPartials.length > 0) {
    const allPartials = withPartials.flatMap((t) => t.partialCloses!);
    const byReason = new Map<string, number>();
    for (const p of allPartials)
      byReason.set(p.reason, (byReason.get(p.reason) ?? 0) + 1);
    console.log(
      `\n  Partial closes: ${allPartials.length} across ${withPartials.length} trades`,
    );
    for (const [reason, count] of byReason)
      console.log(`    ${reason}: ${count}`);
  }
  console.log("==========================================");
}

function runStrategyBacktest(
  candles: Map<string, Candle[]>,
  strategy: StrategyType,
): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  STRATEGY: ${strategy.toUpperCase()} (Hyperliquid data)`);
  console.log("=".repeat(60));

  const backtestConfig: BacktestConfig = {
    coins: COINS,
    timeframes: TIMEFRAMES,
    initialCapital: INITIAL_CAPITAL,
    slippagePct: BACKTEST_SLIPPAGE_PCT,
    commissionPct: HL_COMMISSION_PCT,
    strategy,
  };

  const diagResult = runBacktest(candles, backtestConfig);

  if (diagResult.pipelineStats) {
    console.log(`\n${formatPipelineStats(diagResult.pipelineStats)}`);
  }

  log.info(
    "hl-backtest",
    `${strategy}: ${diagResult.trades.length} trades on full dataset`,
  );
  printTradeDetails(diagResult.trades);

  // Walk-forward validation
  const wfConfig: WalkForwardConfig = {
    backtestConfig,
    trainWindowMs: WF_TRAIN_WINDOW_MS,
    testWindowMs: WF_TEST_WINDOW_MS,
    stepMs: WF_STEP_MS,
  };

  const wfResult = walkForward(candles, wfConfig);
  console.log(`\n${formatExpectancyReport(wfResult)}`);
  console.log(`\n${formatMetricsSummary(wfResult.isMetrics, "IS")}`);
  console.log(formatMetricsSummary(wfResult.oosMetrics, "OOS"));

  if (wfResult.passesGate) {
    log.info("hl-backtest", `${strategy}: GATE PASSED`);
  } else {
    log.warn("hl-backtest", `${strategy}: GATE FAILED`);
  }
}

function normalizeStrategyArg(raw: string | undefined): StrategyType {
  const value = raw?.trim().toLowerCase() ?? "smc-sd";
  if (value === "smc-sd" || value === "all") return "smc-sd";
  log.warn(
    "hl-backtest",
    `Unsupported strategy "${value}" - using canonical setup engine smc-sd`,
  );
  return "smc-sd";
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const strategy = normalizeStrategyArg(process.argv[2]);

  console.log("=".repeat(60));
  console.log("  HYPERLIQUID BACKTEST RUNNER");
  console.log(`  Coins: ${COINS.join(", ")}`);
  console.log(`  Timeframes: ${TIMEFRAMES.join(", ")}`);
  console.log(`  Setup engine: ${strategy}`);
  console.log(
    `  Commission: ${(HL_COMMISSION_PCT * 100).toFixed(3)}% (HL taker)`,
  );
  console.log("=".repeat(60));

  const extraHTFs = computeExtraHTFs(TIMEFRAMES);
  if (extraHTFs.length > 0) {
    log.info(
      "hl-backtest",
      `Extra HTF intervals for bias warmup: ${extraHTFs.join(", ")}`,
    );
  }

  log.info("hl-backtest", "Fetching candles from Hyperliquid REST API...");
  const candles = await fetchAllCandles(COINS, TIMEFRAMES, extraHTFs);

  let totalCandles = 0;
  for (const [, series] of candles) totalCandles += series.length;

  if (totalCandles === 0) {
    log.error(
      "hl-backtest",
      "No candle data fetched. Check network / HL API availability.",
    );
    process.exit(1);
  }

  log.info(
    "hl-backtest",
    `Total: ${totalCandles} candles across ${candles.size} series`,
  );

  runStrategyBacktest(candles, strategy);

  log.info("hl-backtest", "Done.");
}

main().catch((err) => {
  log.error(
    "hl-backtest",
    `Fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
