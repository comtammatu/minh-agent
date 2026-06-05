/**
 * Terminal UI — ANSI formatting for agent state display + setup alerts.
 *
 * S15: Zero-dependency ANSI escape codes for visual polish.
 *
 * Design:
 *   - Pure formatting functions (testable, no I/O)
 *   - Thin wiring layer (printXxx) for stdout
 *   - Colors: green LONG, red SHORT, yellow WARNING, dim STATUS, bold SETUP
 *   - Agent state badges: [IDLE] [WATCHING] [IN_POSITION] [PAUSED]
 */

import type { AgentAction, AgentSnapshot, AgentState } from "../agent/types.js";
import type { ConfluenceGrade } from "../types.js";

// ─── ANSI Escape Codes ────────────────────────────────────────────────────

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",

  // Foreground
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Background
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────

function c(color: string, text: string): string {
  return `${color}${text}${ANSI.reset}`;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

// ─── Side Formatting ──────────────────────────────────────────────────────

export function formatSide(side: "long" | "short"): string {
  return side === "long"
    ? c(ANSI.bold + ANSI.green, "LONG")
    : c(ANSI.bold + ANSI.red, "SHORT");
}

// ─── Grade Badge ──────────────────────────────────────────────────────────

export function formatGrade(grade: ConfluenceGrade): string {
  switch (grade) {
    case "A+":
      return c(ANSI.bold + ANSI.bgMagenta + ANSI.white, " A+ ");
    case "A":
      return c(ANSI.bold + ANSI.bgGreen + ANSI.white, " A ");
    case "B":
      return c(ANSI.bold + ANSI.bgBlue + ANSI.white, " B ");
    case "C":
      return c(ANSI.dim, "[C]");
  }
}

// ─── Agent State Badge ────────────────────────────────────────────────────

export function formatState(state: AgentState): string {
  switch (state) {
    case "IDLE":
      return c(ANSI.dim, "[IDLE]");
    case "WATCHING":
      return c(ANSI.cyan, "[WATCHING]");
    case "ENTERING":
      return c(ANSI.yellow, "[ENTERING]");
    case "IN_POSITION":
      return c(ANSI.bold + ANSI.green, "[IN_POSITION]");
    case "EXITING":
      return c(ANSI.yellow, "[EXITING]");
    case "PAUSED":
      return c(ANSI.bold + ANSI.red, "[PAUSED]");
  }
}

// ─── PnL Formatting ──────────────────────────────────────────────────────

export function formatPnl(pnl: number): string {
  const str = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);
  return pnl >= 0 ? c(ANSI.green, str) : c(ANSI.red, str);
}

// ─── Setup Alert ──────────────────────────────────────────────────────────

function formatSignalPriceTerminal(value: unknown): string {
  if (value == null || typeof value !== "number" || !Number.isFinite(value))
    return "—";
  const n = value;
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}

export function formatSetupAlert(
  action: AgentAction & { type: "log_journal" },
): string | null {
  const { eventType, coin, details } = action;
  if (eventType !== "signal") return null;

  const grade = (details.grade as ConfluenceGrade | undefined) ?? "C";
  const confidence =
    details.confidence != null
      ? (Number(details.confidence) * 100).toFixed(0)
      : "?";
  const setupId = String(details.setupId ?? "");
  const interval = details.interval != null ? String(details.interval) : "";
  const entry = formatSignalPriceTerminal(details.entryPrice);
  const sl = formatSignalPriceTerminal(details.slPrice);
  const tp = formatSignalPriceTerminal(details.tpPrice);

  return [
    `${c(ANSI.bold, "⚡ SETUP")} ${formatGrade(grade)} ${coin} ${formatSide((details.side as "long" | "short") ?? "long")}${interval ? ` ${c(ANSI.cyan, interval)}` : ""}`,
    `  ${c(ANSI.dim, `entry ${entry} | SL ${sl} | TP ${tp}`)} | conf: ${confidence}%`,
    `  id: ${c(ANSI.dim, setupId)}`,
  ].join("\n");
}

// ─── Action Formatter (for terminal output) ──────────────────────────────

export function formatAction(action: AgentAction): string | null {
  if (action.type !== "log_journal") return null;

  const { eventType, coin, details } = action;

  switch (eventType) {
    case "signal": {
      const grade = (details.grade as ConfluenceGrade | undefined) ?? "C";
      const confidence =
        details.confidence != null
          ? (Number(details.confidence) * 100).toFixed(0)
          : "?";
      const interval = details.interval != null ? String(details.interval) : "";
      const entry = formatSignalPriceTerminal(details.entryPrice);
      const sl = formatSignalPriceTerminal(details.slPrice);
      const tp = formatSignalPriceTerminal(details.tpPrice);
      const head = `[${ts()}] ${c(ANSI.bold, "⚡ SETUP")} | ${coin}${interval ? ` ${interval}` : ""} ${formatGrade(grade)} | ${formatSide((details.side as "long" | "short") ?? "long")} conf:${confidence}%`;
      const geom = `         ${c(ANSI.dim, `entry ${entry} | SL ${sl} | TP ${tp}`)}`;
      return `${head}\n${geom}`;
    }

    case "enter": {
      const side = details.side as "long" | "short" | undefined;
      const price =
        details.fillPrice != null ? Number(details.fillPrice).toFixed(4) : "?";
      return `[${ts()}] ${c(ANSI.bold + ANSI.green, "✓ FILLED")} | ${coin} ${formatSide(side ?? "long")} @ ${price}`;
    }

    case "exit": {
      const pnl = details.pnl != null ? Number(details.pnl) : 0;
      const reason = String(details.reason ?? "unknown");
      return `[${ts()}] ${c(ANSI.bold, "✕ CLOSED")} | ${coin} ${formatPnl(pnl)} USDC | ${reason}`;
    }

    case "skip": {
      const reason = String(details.reason ?? "");
      return `[${ts()}] ${c(ANSI.dim, "⏭ SKIP")} | ${coin} | ${reason}`;
    }

    case "invalidate": {
      const reason = String(details.reason ?? "");
      const hasPosition = !!details.positionId;
      const prefix = hasPosition
        ? c(ANSI.bold + ANSI.yellow, "⚠ INVALID+CLOSE")
        : c(ANSI.yellow, "⚠ INVALID");
      return `[${ts()}] ${prefix} | ${coin} | ${reason}`;
    }

    case "circuit_break": {
      const reason = String(details.reason ?? "");
      return `[${ts()}] ${c(ANSI.bold + ANSI.bgRed + ANSI.white, " 🚨 CIRCUIT BREAKER ")} | ${reason}`;
    }

    case "pause": {
      const reason = String(details.reason ?? "");
      return `[${ts()}] ${c(ANSI.bold + ANSI.red, "⏸ PAUSED")} | ${coin} | ${reason}`;
    }

    case "resume": {
      return `[${ts()}] ${c(ANSI.green, "▶ RESUMED")} | ${coin}`;
    }

    case "error": {
      const reason = String(details.reason ?? "");
      return `[${ts()}] ${c(ANSI.bold + ANSI.red, "✗ ERROR")} | ${coin} | ${reason}`;
    }

    default:
      return null;
  }
}

// ─── Agent Snapshot Status Line ──────────────────────────────────────────

export function formatAgentStatus(snapshot: AgentSnapshot): string {
  const coins = Object.entries(snapshot.coins);
  const active = coins.filter(([, v]) => v.state !== "IDLE");
  const idle = coins.length - active.length;

  const { dailyPnl, globalPaused } = snapshot.global;
  const pnlStr = formatPnl(dailyPnl);
  const pauseTag = globalPaused ? c(ANSI.bold + ANSI.red, " PAUSED") : "";

  // Active coins summary
  const activeParts = active.map(
    ([coin, v]) => `${coin}${formatState(v.state)}`,
  );

  const parts = [
    `[${ts()}]`,
    c(ANSI.dim, "AGENT"),
    `PnL:${pnlStr}`,
    `${idle}idle`,
  ];

  if (activeParts.length > 0) {
    parts.push(activeParts.join(" "));
  }

  if (pauseTag) parts.push(pauseTag);

  return parts.join(" | ");
}
