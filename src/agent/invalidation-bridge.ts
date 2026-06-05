/**
 * Invalidation → Action Bridge (Sprint 2 S8).
 *
 * Connects Sprint 1 invalidation engine to Sprint 2 execution:
 *   1. Receives invalidation events from pipeline EventEmitter
 *   2. Verifies the invalidated setup matches the coin's active setup (setupId match)
 *   3. Dispatches setup_invalidated to the TradingAgent state machine
 *   4. Logs the invalidation → action chain with full context
 *
 * Why a dedicated module:
 *   - Setup ID matching prevents cross-TF mismatch (BTC:1h:ob vs BTC:15m:fvg)
 *   - Centralized audit trail for invalidation → action chain
 *   - Clean separation: pipeline emits → bridge validates → agent acts
 *
 * Design:
 *   - No I/O — delegates execution to agent dispatch
 *   - Stateless — reads agent coin state for matching, doesn't store own state
 *   - Wire once via `bridge.connect(pipelineEmitter, agent)`
 */

import type { EventEmitter } from "node:events";
import { log } from "../lib/logger.js";
import type { TradingAgent } from "./trading-agent.js";
import type { AgentState } from "./types.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface InvalidationRecord {
  setupId: string;
  reason: string;
  coin: string;
  coinState: AgentState;
  matched: boolean;
  actionTaken: "none" | "drop_watch" | "cancel_order" | "close_position";
  ts: number;
}

/** Aggregated invalidation counters (live TUI + ops). */
export interface InvalidationBridgeStats {
  total: number;
  matched: number;
  skipped: number;
  parseFailed: number;
  actions: Record<string, number>;
}

// ─── Bridge ────────────────────────────────────────────────────────────────

export class InvalidationBridge {
  /** Recent invalidation records for audit (ring buffer, last N). */
  private history: InvalidationRecord[] = [];
  private maxHistory = 200;

  /**
   * Wire the bridge between pipeline and agent.
   * Replaces TradingAgent.subscribeToPipeline's invalidation handler.
   */
  connect(pipelineEmitter: EventEmitter, agent: TradingAgent): void {
    pipelineEmitter.on("invalidation", (setupId: string, reason: string) => {
      this.onInvalidation(setupId, reason, agent);
    });
    log.info("invalidation-bridge", "Connected to pipeline");
  }

  /**
   * Handle an invalidation event from the pipeline.
   *
   * 1. Parse coin from setupId
   * 2. Check if the coin's active setup matches the invalidated setupId
   * 3. If match → dispatch setup_invalidated to agent
   * 4. If no match → log and skip (different TF/type, stale setup)
   */
  onInvalidation(
    setupId: string,
    reason: string,
    agent: TradingAgent,
  ): InvalidationRecord {
    const coin = parseCoinFromSetupId(setupId);
    if (!coin) {
      log.warn(
        "invalidation-bridge",
        `Cannot parse coin from setupId: ${setupId}`,
      );
      return this.record(setupId, reason, "unknown", "IDLE", false, "none");
    }

    const ctx = agent.getCoinContext(coin);
    const matchedCtx =
      ctx?.activeSetup?.id === setupId ? { state: ctx.state } : null;

    if (!matchedCtx) {
      const coinState = agent.getCoinState(coin);
      log.debug(
        "invalidation-bridge",
        `Invalidation for ${setupId}: no matching active setup — skipping`,
      );
      return this.record(setupId, reason, coin, coinState, false, "none");
    }

    const coinState = matchedCtx.state as AgentState;
    // Match! Dispatch to agent and determine action.
    const actionTaken = predictAction(coinState);
    log.info(
      "invalidation-bridge",
      `INVALIDATION → ACTION | ${coin} | state=${coinState} | setup=${setupId} | reason=${reason} | action=${actionTaken}`,
    );

    agent.dispatch(coin, { type: "setup_invalidated", setupId, reason });

    return this.record(setupId, reason, coin, coinState, true, actionTaken);
  }

  /** Get recent invalidation history (for API / journal). */
  getHistory(): readonly InvalidationRecord[] {
    return this.history;
  }

  getStats(): InvalidationBridgeStats {
    const actions: Record<string, number> = {};
    let matched = 0;
    let skipped = 0;
    let parseFailed = 0;

    for (const r of this.history) {
      actions[r.actionTaken] = (actions[r.actionTaken] ?? 0) + 1;
      if (r.coin === "unknown") {
        parseFailed++;
        continue;
      }
      if (r.matched) {
        matched++;
      } else {
        skipped++;
      }
    }
    return {
      total: this.history.length,
      matched,
      skipped,
      parseFailed,
      actions,
    };
  }

  /** Clear history (tests). */
  clearHistory(): void {
    this.history = [];
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private record(
    setupId: string,
    reason: string,
    coin: string,
    coinState: AgentState,
    matched: boolean,
    actionTaken: InvalidationRecord["actionTaken"],
  ): InvalidationRecord {
    const record: InvalidationRecord = {
      setupId,
      reason,
      coin,
      coinState,
      matched,
      actionTaken,
      ts: Date.now(),
    };
    this.history.push(record);
    // Ring buffer
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    return record;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Parse coin name from setupId.
 *
 * Supported formats:
 * - Canonical: `COIN|interval|type`
 * - Legacy prefixed: `prefix:COIN|interval|type`
 * - Legacy: `COIN|interval|type|side`
 */
export function parseCoinFromSetupId(setupId: string): string | null {
  const parts = setupId.split("|");
  if (!parts[0] || parts.length < 3) return null;

  // Legacy prefixed setup ids used "<prefix>:COIN" as the first segment.
  const first = parts[0];
  const idx = first.lastIndexOf(":");
  if (idx !== -1) {
    const coin = first.slice(idx + 1);
    return coin.length > 0 ? coin : null;
  }

  // Legacy: "COIN"
  return first;
}

/**
 * Predict what action the state machine will take for a given state.
 * Used for logging — actual action determined by the state handlers.
 */
function predictAction(state: AgentState): InvalidationRecord["actionTaken"] {
  switch (state) {
    case "IDLE":
    case "PAUSED":
      return "none";
    case "WATCHING":
      return "drop_watch";
    case "ENTERING":
      return "cancel_order";
    case "IN_POSITION":
    case "EXITING":
      return "close_position";
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let instance: InvalidationBridge | null = null;

export function getInvalidationBridge(): InvalidationBridge {
  if (!instance) {
    instance = new InvalidationBridge();
  }
  return instance;
}

export function resetInvalidationBridge(): void {
  instance = null;
}
