/**
 * Expectancy report formatter — plain text summary for console/log.
 *
 * Takes WalkForwardResult and produces a readable report with:
 *   - Per-window train vs test metrics
 *   - Aggregated OOS vs IS comparison
 *   - Overfit detection flag
 *   - Pass/fail gate verdict
 *
 * Pure function, zero I/O.
 *
 * Sprint 3 S4.
 */

import { WF_OVERFIT_THRESHOLD } from "../config.js";
import type {
  BacktestMetrics,
  WalkForwardResult,
  WalkForwardWindow,
} from "./types.js";

/**
 * Format a walk-forward result into a readable text report.
 */
export function formatExpectancyReport(result: WalkForwardResult): string {
  const lines: string[] = [];

  lines.push("=".repeat(60));
  lines.push("  WALK-FORWARD VALIDATION REPORT");
  lines.push("=".repeat(60));
  lines.push("");

  // Gate verdict (top of report for quick scanning)
  if (result.windows.length === 0) {
    lines.push("  VERDICT: INSUFFICIENT DATA");
    lines.push("  Not enough data for minimum number of walk-forward windows.");
    lines.push("=".repeat(60));
    return lines.join("\n");
  }

  const verdict = result.passesGate ? "PASS" : "FAIL";
  const verdictSymbol = result.passesGate ? "[+]" : "[-]";
  lines.push(`  ${verdictSymbol} VERDICT: ${verdict}`);
  lines.push(
    `  OOS Expectancy: $${fmtNum(result.oosMetrics.expectancy)} per trade`,
  );

  if (result.overfitRatio > WF_OVERFIT_THRESHOLD) {
    lines.push(
      `  [!] OVERFIT WARNING: IS/OOS ratio = ${fmtNum(result.overfitRatio)}x (threshold: ${WF_OVERFIT_THRESHOLD}x)`,
    );
  }

  lines.push("");
  lines.push("-".repeat(60));

  // Summary table: IS vs OOS
  lines.push("  IN-SAMPLE vs OUT-OF-SAMPLE SUMMARY");
  lines.push("-".repeat(60));
  lines.push(formatComparisonTable(result.isMetrics, result.oosMetrics));

  lines.push("");
  lines.push("-".repeat(60));

  // Per-window breakdown
  lines.push("  PER-WINDOW BREAKDOWN");
  lines.push("-".repeat(60));

  for (const w of result.windows) {
    lines.push(formatWindowRow(w));
  }

  lines.push("");
  lines.push("=".repeat(60));

  return lines.join("\n");
}

/**
 * Format a single BacktestMetrics into a concise one-line summary.
 */
export function formatMetricsSummary(
  m: BacktestMetrics,
  label?: string,
): string {
  const prefix = label ? `[${label}] ` : "";
  return `${prefix}Trades: ${m.totalTrades} | WR: ${pct(m.winRate)} | PnL: $${fmtNum(m.netPnl)} | Exp: $${fmtNum(m.expectancy)} | Sharpe: ${fmtNum(m.sharpeRatio)} | MaxDD: ${pct(m.maxDrawdown)} | PF: ${fmtNum(m.profitFactor)}`;
}

// ─── Internal ──────────────────────────────────────────────────────────────

function formatComparisonTable(
  is: BacktestMetrics,
  oos: BacktestMetrics,
): string {
  const rows = [
    ["Metric", "In-Sample", "Out-of-Sample", "Delta"],
    [
      "Trades",
      `${is.totalTrades}`,
      `${oos.totalTrades}`,
      `${oos.totalTrades - is.totalTrades}`,
    ],
    [
      "Win Rate",
      pct(is.winRate),
      pct(oos.winRate),
      delta(oos.winRate - is.winRate, true),
    ],
    [
      "Net PnL",
      `$${fmtNum(is.netPnl)}`,
      `$${fmtNum(oos.netPnl)}`,
      `$${fmtNum(oos.netPnl - is.netPnl)}`,
    ],
    [
      "Expectancy",
      `$${fmtNum(is.expectancy)}`,
      `$${fmtNum(oos.expectancy)}`,
      `$${fmtNum(oos.expectancy - is.expectancy)}`,
    ],
    [
      "Profit Factor",
      fmtNum(is.profitFactor),
      fmtNum(oos.profitFactor),
      fmtNum(oos.profitFactor - is.profitFactor),
    ],
    [
      "Sharpe",
      fmtNum(is.sharpeRatio),
      fmtNum(oos.sharpeRatio),
      fmtNum(oos.sharpeRatio - is.sharpeRatio),
    ],
    [
      "Sortino",
      fmtNum(is.sortinoRatio),
      fmtNum(oos.sortinoRatio),
      fmtNum(oos.sortinoRatio - is.sortinoRatio),
    ],
    [
      "Max Drawdown",
      pct(is.maxDrawdown),
      pct(oos.maxDrawdown),
      delta(oos.maxDrawdown - is.maxDrawdown, true),
    ],
    [
      "Avg R:R",
      fmtNum(is.avgRR),
      fmtNum(oos.avgRR),
      fmtNum(oos.avgRR - is.avgRR),
    ],
    [
      "Avg Hold (bars)",
      fmtNum(is.avgHoldingBars),
      fmtNum(oos.avgHoldingBars),
      fmtNum(oos.avgHoldingBars - is.avgHoldingBars),
    ],
  ];

  // Compute column widths
  const widths = rows[0]?.map((_, col) =>
    Math.max(...rows.map((r) => r[col]?.length)),
  );

  return rows
    .map((row, i) => {
      const cells = row.map((cell, col) => cell.padStart(widths[col]!));
      const line = `  ${cells.join("  |  ")}`;
      if (i === 0) return `${line}\n  ${"-".repeat(line.length - 2)}`;
      return line;
    })
    .join("\n");
}

function formatWindowRow(w: WalkForwardWindow): string {
  const trainRange = `${fmtDate(w.trainStart)}→${fmtDate(w.trainEnd)}`;
  const testRange = `${fmtDate(w.testStart)}→${fmtDate(w.testEnd)}`;
  const trainSummary = `T:${w.trainMetrics.totalTrades} WR:${pct(w.trainMetrics.winRate)} Exp:$${fmtNum(w.trainMetrics.expectancy)}`;
  const testSummary = `T:${w.testMetrics.totalTrades} WR:${pct(w.testMetrics.winRate)} Exp:$${fmtNum(w.testMetrics.expectancy)}`;

  return `  W${w.index} Train[${trainRange}] ${trainSummary}\n     Test [${testRange}] ${testSummary}`;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "Inf" : "-Inf";
  return n.toFixed(2);
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return "Inf%";
  return `${(n * 100).toFixed(1)}%`;
}

function delta(n: number, asPct: boolean): string {
  const formatted = asPct ? pct(n) : fmtNum(n);
  return n >= 0 ? `+${formatted}` : formatted;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
