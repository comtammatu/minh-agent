/**
 * R6: Simple log helper — levels + timestamps + component tags.
 * No external dependencies.
 */

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "INFO";

/** Exported for testing (E21) — pure function, no side effects */
export function _fmt(level: LogLevel, component: string, msg: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.padEnd(5)}] [${component}] ${msg}`;
}

/** Exported for testing (E21) — returns which console method a level routes to */
export function _route(level: LogLevel): "error" | "warn" | "log" {
  if (level === "ERROR") return "error";
  if (level === "WARN") return "warn";
  return "log";
}

/** Exported for testing (E21) — returns true if level passes the minimum filter */
export function _passes(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

// ─── TUI Sink ────────────────────────────────────────────────────────────

let tuiSink: ((msg: string) => void) | null = null;

/** Route log output to TUI panel instead of console. Call after startTui(). */
export function setTuiSink(sink: (msg: string) => void): void {
  tuiSink = sink;
}

/** Restore log output to console. Call before stopTui(). */
export function clearTuiSink(): void {
  tuiSink = null;
}

function write(level: LogLevel, component: string, msg: string): void {
  if (!_passes(level)) return;
  const line = _fmt(level, component, msg);
  if (tuiSink) {
    tuiSink(line);
  } else {
    const method = _route(level);
    console[method](line);
  }
}

export const log = {
  debug: (component: string, msg: string) => write("DEBUG", component, msg),
  info: (component: string, msg: string) => write("INFO", component, msg),
  warn: (component: string, msg: string) => write("WARN", component, msg),
  error: (component: string, msg: string) => write("ERROR", component, msg),
};
