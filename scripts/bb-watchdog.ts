/**
 * Bybit external dead-man-switch watchdog.
 *
 * Independent Bun process. Polls the heartbeat file written by the main
 * runtime; if the file is stale beyond `BB_HEARTBEAT_THRESHOLD_MS`, calls
 * Bybit `cancelAllOpenOrders` and exits non-zero (the supervisor restarts us).
 *
 * Run:
 *   ACTIVE_EXCHANGE=BB PAPER_TRADE=false bun run scripts/bb-watchdog.ts
 *
 * See: docs/operations/dead-man-switch.md
 *
 * IMPORTANT: This script MUST NOT import from src/runtime/ or src/agent/.
 * Those modules pull the full runtime (DB, feeds, TUI). The watchdog is a
 * minimal process — only execution + config + the pure heartbeat helpers.
 */

import {
  BB_HEARTBEAT_PATH,
  BB_HEARTBEAT_THRESHOLD_MS,
  BB_HEARTBEAT_WRITE_MS,
  isBbWatchdogEnabled,
} from "../src/config.js";
import { BybitExchangeService } from "../src/execution/bybit-exchange-service.js";
import { log } from "../src/lib/logger.js";
import {
  type HeartbeatRecord,
  isPidAlive,
  readHeartbeat,
} from "../src/runtime/heartbeat.js";

/** Decision returned by {@link evaluateHeartbeat}. */
export type WatchdogDecision =
  | { action: "sleep"; reason: "no-heartbeat-file" }
  | { action: "sleep"; reason: "fresh" }
  | { action: "cancel"; reason: "stale-and-dead"; pid: number; ageMs: number }
  | { action: "cancel"; reason: "stale-but-alive"; pid: number; ageMs: number };

/**
 * Pure decision logic — given a heartbeat record (or absence), a current
 * timestamp, a staleness threshold, and a liveness probe, return what the
 * watchdog should do. Side effects (file IO, Bybit call) happen in the loop.
 *
 * Decision matrix:
 *  - missing file        → sleep (treated as intentional shutdown)
 *  - file present, fresh → sleep
 *  - file present, stale:
 *      pid alive  → cancel (process is up but not heartbeating = freeze)
 *      pid dead   → cancel (process crashed, file never deleted)
 */
export function evaluateHeartbeat(args: {
  record: HeartbeatRecord | null;
  now: number;
  thresholdMs: number;
  isAlive: (pid: number) => boolean;
}): WatchdogDecision {
  const { record, now, thresholdMs, isAlive } = args;
  if (record === null) {
    return { action: "sleep", reason: "no-heartbeat-file" };
  }
  const ageMs = now - record.ts;
  if (ageMs < thresholdMs) {
    return { action: "sleep", reason: "fresh" };
  }
  if (isAlive(record.pid)) {
    return {
      action: "cancel",
      reason: "stale-but-alive",
      pid: record.pid,
      ageMs,
    };
  }
  return { action: "cancel", reason: "stale-and-dead", pid: record.pid, ageMs };
}

async function main(): Promise<void> {
  if (!isBbWatchdogEnabled()) {
    log.error(
      "bb-watchdog",
      "refusing to start: BB watchdog is only enabled when ACTIVE_EXCHANGE=BB AND PAPER_TRADE=false",
    );
    process.exit(2);
  }

  log.info(
    "bb-watchdog",
    `armed | path ${BB_HEARTBEAT_PATH} | poll ${BB_HEARTBEAT_WRITE_MS / 1000}s | threshold ${BB_HEARTBEAT_THRESHOLD_MS / 1000}s`,
  );

  const svc = new BybitExchangeService();
  try {
    await svc.init();
  } catch (err) {
    log.error(
      "bb-watchdog",
      `Bybit init failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(3);
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  // Loop forever; exit non-zero after firing so the supervisor restarts a
  // clean instance (kills any timers, drops any half-initialised state).
  while (true) {
    const record = readHeartbeat(BB_HEARTBEAT_PATH);
    const decision = evaluateHeartbeat({
      record,
      now: Date.now(),
      thresholdMs: BB_HEARTBEAT_THRESHOLD_MS,
      isAlive: isPidAlive,
    });

    if (decision.action === "sleep") {
      await sleep(BB_HEARTBEAT_WRITE_MS);
      continue;
    }

    log.error(
      "bb-watchdog",
      `FREEZE DETECTED | reason=${decision.reason} pid=${decision.pid} age=${Math.round(decision.ageMs / 1000)}s — calling cancelAllOpenOrders()`,
    );

    try {
      const result = await svc.cancelAllOpenOrders();
      if (result.success) {
        log.error(
          "bb-watchdog",
          "cancelAllOpenOrders OK — exiting non-zero for supervisor restart",
        );
      } else {
        log.error(
          "bb-watchdog",
          `cancelAllOpenOrders failed: ${result.error} — exiting anyway`,
        );
      }
    } catch (err) {
      log.error(
        "bb-watchdog",
        `cancelAllOpenOrders exception: ${err instanceof Error ? err.message : err}`,
      );
    }
    process.exit(1);
  }
}

// Only run when invoked directly (allows the file to be imported by tests
// without spinning up the loop). Bun fills import.meta.main like Deno.
if (import.meta.main) {
  main().catch((err) => {
    log.error(
      "bb-watchdog",
      `fatal: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(4);
  });
}
