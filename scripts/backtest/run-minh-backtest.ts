/**
 * SMC+SD Quick Backtest — P0+P1 validation.
 *
 * Usage: bun run scripts/backtest/run-minh-backtest.ts
 *
 * Fetches real HL data (BTC/ETH/SOL, 1h+4h, 1000 candles each),
 * runs minh strategy through the backtest engine, prints metrics.
 * No PostgreSQL required.
 */

import { runBacktest } from "../../src/backtest/engine.js";
import { formatMetricsSummary } from "../../src/backtest/report.js";
import type { BacktestConfig } from "../../src/backtest/types.js";
import { fetchCandlesBatched } from "../../src/feed/rest.js";
import { log } from "../../src/lib/logger.js";
import type { Candle, CandleInterval } from "../../src/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const COINS = ["BTC", "ETH", "SOL"];
const TIMEFRAMES: CandleInterval[] = ["1h", "4h"];
const CANDLE_COUNT = 1000; // ~42 days on 1h, ~167 days on 4h
const INITIAL_CAPITAL = 10_000;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n====================================================");
  console.log("  SMC+SD BACKTEST — P0+P1 validation");
  console.log("  Coins:", COINS.join(", "));
  console.log("  TFs  :", TIMEFRAMES.join(", "));
  console.log("  Bars :", CANDLE_COUNT, "per series");
  console.log("====================================================\n");

  // Fetch candles
  const candleMap = new Map<string, Candle[]>();

  for (const coin of COINS) {
    for (const tf of TIMEFRAMES) {
      process.stdout.write(`Fetching ${coin} ${tf} ... `);
      const candles = await fetchCandlesBatched(coin, tf, CANDLE_COUNT);
      if (!candles || candles.length === 0) {
        console.log("FAILED — skipping");
        continue;
      }
      candleMap.set(`${coin}|${tf}`, candles);
      console.log(
        `OK (${candles.length} candles, ${new Date(candles[0]!.t).toISOString().slice(0, 10)} → ${new Date(candles.at(-1)!.t).toISOString().slice(0, 10)})`,
      );
    }
  }

  if (candleMap.size === 0) {
    log.error("backtest", "No candle data fetched — check network / HL API");
    process.exit(1);
  }

  console.log(`\nLoaded ${candleMap.size} series. Running backtest...\n`);

  // Run backtest
  const config: BacktestConfig = {
    coins: COINS,
    timeframes: TIMEFRAMES,
    initialCapital: INITIAL_CAPITAL,
    slippagePct: 0.0003, // HL taker
    commissionPct: 0.0003,
    strategy: "minh",
    exitMode: "multi",
  };

  const result = runBacktest(candleMap, config);
  const m = result.metrics;

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("====================================================");
  console.log("  RESULTS");
  console.log("====================================================");
  console.log(formatMetricsSummary(m, "SMC-SD"));

  console.log("\n  Detail:");
  console.log(`  Total trades  : ${m.totalTrades}`);
  console.log(`  Win rate      : ${(m.winRate * 100).toFixed(1)}%`);
  console.log(`  Expectancy    : $${m.expectancy.toFixed(2)} per trade`);
  console.log(`  Avg win       : $${m.avgWin.toFixed(2)}`);
  console.log(`  Avg loss      : $${m.avgLoss.toFixed(2)}`);
  console.log(`  Profit factor : ${m.profitFactor.toFixed(2)}`);
  console.log(`  Max drawdown  : ${(m.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  Sharpe        : ${m.sharpeRatio.toFixed(2)}`);
  console.log(`  Net PnL       : $${m.netPnl.toFixed(2)}`);
  console.log(`  Final equity  : $${(INITIAL_CAPITAL + m.netPnl).toFixed(2)}`);

  // ── Trade log ─────────────────────────────────────────────────────────────
  if (result.trades.length > 0) {
    console.log(`\n  Trade breakdown (${result.trades.length} trades):`);
    console.log(
      "  Coin    TF    Side   Entry         SL%    TP%    R:R    PnL        Exit",
    );
    for (const t of result.trades) {
      const slPct = (Math.abs(t.entryPrice - t.slPrice) / t.entryPrice) * 100;
      const tpPct = (Math.abs(t.tpPrice - t.entryPrice) / t.entryPrice) * 100;
      const rr = slPct > 0 ? tpPct / slPct : 0;
      const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2);
      const fmt = (n: number) => (n >= 1000 ? n.toFixed(0) : n.toFixed(4));
      console.log(
        `  ${t.coin.padEnd(7)} ${t.interval.padEnd(5)} ${t.side.padEnd(6)} ` +
          `${fmt(t.entryPrice).padEnd(13)} ` +
          `${slPct.toFixed(2).padStart(5)}% ` +
          `${tpPct.toFixed(2).padStart(6)}% ` +
          `${rr.toFixed(2).padStart(5)} ` +
          `${pnlStr.padStart(10)}  ` +
          `${t.exitReason}`,
      );
    }

    // Breakdown by exit reason
    const byExit = new Map<string, { count: number; pnl: number }>();
    for (const t of result.trades) {
      const e = byExit.get(t.exitReason) ?? { count: 0, pnl: 0 };
      e.count++;
      e.pnl += t.pnl;
      byExit.set(t.exitReason, e);
    }
    console.log("\n  Exit reason summary:");
    for (const [reason, { count, pnl }] of [...byExit.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    )) {
      console.log(
        `    ${reason.padEnd(15)} ${String(count).padStart(3)} trades  PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      );
    }
  } else {
    console.log("\n  No trades generated — check config or data range.");
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log("\n====================================================");
  const passes = m.expectancy > 0 && m.winRate >= 0.3 && m.maxDrawdown < 0.2;
  console.log(`  VERDICT: ${passes ? "✅ PASS" : "❌ FAIL"}`);
  if (!passes) {
    if (m.expectancy <= 0) console.log("  ⚠️  Negative expectancy");
    if (m.winRate < 0.3)
      console.log(`  ⚠️  Win rate ${(m.winRate * 100).toFixed(1)}% < 30% floor`);
    if (m.maxDrawdown >= 0.2)
      console.log(
        `  ⚠️  Max drawdown ${(m.maxDrawdown * 100).toFixed(1)}% ≥ 20% limit`,
      );
  }
  console.log("====================================================\n");
}

main().catch((err) => {
  log.error(
    "backtest",
    `Fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
