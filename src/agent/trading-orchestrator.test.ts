/**
 * Trading Orchestrator tests — advisor gate (learning loop v1).
 *
 * Pure handler + lifecycle coverage lives in trading-agent.test.ts. This file
 * covers the dispatch-level advisor gate: shadow journaling, active veto with
 * state revert, active dampen threading, and the fail-open guards (mode off,
 * no provider, null/stale snapshot).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  type AdvisorSnapshot,
  aggregateOutcomes,
  type OutcomeRow,
} from "../advisor/index.js";
import { ADVISOR } from "../config.js";
import type { ActiveSetup } from "../types.js";
import { resetAgent, TradingAgent } from "./trading-orchestrator.js";
import type { AgentAction } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSetup(overrides: Partial<ActiveSetup> = {}): ActiveSetup {
  return {
    id: "BTC|1h|smc-sd|long",
    coin: "BTC",
    interval: "1h",
    type: "smc-sd",
    side: "long",
    confidence: 0.75,
    entryPrice: 50000,
    slPrice: 49000,
    tpPrice: 52000,
    patternData: {},
    detectedAt: Date.now(),
    detectedAtBar: 0,
    expiresAtBar: 100,
    confluenceGrade: "B",
    confluenceCount: 4,
    exchange: "HL",
    ...overrides,
  };
}

/** Build `total` outcome rows, the first `wins` at +1R and the rest at -1R. */
function outcomeRows(
  total: number,
  wins: number,
  overrides: Partial<OutcomeRow> = {},
): OutcomeRow[] {
  return Array.from({ length: total }, (_, i) => ({
    pattern: "smc-sd",
    regime: null,
    side: "long" as const,
    timeframe: null,
    pnlR: i < wins ? 1 : -1,
    pnl: null,
    ...overrides,
  }));
}

function freshSnapshot(rows: OutcomeRow[]): AdvisorSnapshot {
  return aggregateOutcomes(rows, Date.now());
}

function staleSnapshot(rows: OutcomeRow[]): AdvisorSnapshot {
  return aggregateOutcomes(rows, Date.now() - ADVISOR.staleAfterMs - 1_000);
}

function provider(snapshot: AdvisorSnapshot | null) {
  return { getSnapshot: () => snapshot };
}

// Bucket fixtures (ADVISOR: minSample 8, vetoWinRate 0.25, dampenWinRate 0.4,
// smoothing 1/1). 12 trades clears minSample at every level.
const VETO_ROWS = outcomeRows(12, 0); // smoothed WR 1/14 ≈ 0.07, avgR -1 → veto
const DAMPEN_ROWS = outcomeRows(12, 4); // smoothed WR 5/14 ≈ 0.36 → dampen
const ALLOW_ROWS = outcomeRows(12, 8); // smoothed WR 9/14 ≈ 0.64 → allow

// ── Advisor gate ─────────────────────────────────────────────────────────────

describe("TradingAgent — advisor gate", () => {
  let agent: TradingAgent;
  let actions: AgentAction[];

  beforeEach(() => {
    resetAgent();
    agent = new TradingAgent();
    actions = [];
    agent.onAction((a) => actions.push(a));
  });

  function advisorJournals(): Array<
    Extract<AgentAction, { type: "log_journal" }>
  > {
    return actions.filter(
      (a): a is Extract<AgentAction, { type: "log_journal" }> =>
        a.type === "log_journal" && a.eventType === "advisor",
    );
  }

  function placeOrders(): Array<Extract<AgentAction, { type: "place_order" }>> {
    return actions.filter(
      (a): a is Extract<AgentAction, { type: "place_order" }> =>
        a.type === "place_order",
    );
  }

  // ── Shadow mode ──────────────────────────────────────────────────────────

  it("shadow mode journals the verdict without altering actions", () => {
    agent.setAdvisor(provider(freshSnapshot(VETO_ROWS)), "shadow");
    const setup = makeSetup();

    agent.dispatch("BTC", { type: "setup_detected", setup });

    expect(agent.getCoinState("BTC")).toBe("ENTERING");
    expect(placeOrders()).toHaveLength(1);
    expect(placeOrders()[0]?.setup).toBe(setup); // original, untouched
    expect(setup.patternData.advisorSizeMultiplier).toBeUndefined();

    const journals = advisorJournals();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.details).toMatchObject({
      setupId: setup.id,
      mode: "shadow",
      applied: false,
      action: "veto",
      bucketKey: "smc-sd|long",
      sampleSize: 12,
    });
    expect(typeof journals[0]?.details.reason).toBe("string");
  });

  // ── Active mode: veto ────────────────────────────────────────────────────

  it("active veto removes place_order and reverts state to IDLE", () => {
    agent.setAdvisor(provider(freshSnapshot(VETO_ROWS)), "active");

    agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });

    expect(agent.getCoinState("BTC")).toBe("IDLE");
    expect(placeOrders()).toHaveLength(0);

    const journals = advisorJournals();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.details).toMatchObject({
      mode: "active",
      applied: true,
      action: "veto",
      bucketKey: "smc-sd|long",
    });
  });

  // ── Active mode: dampen ──────────────────────────────────────────────────

  it("active dampen threads sizeMultiplier into a patternData copy", () => {
    agent.setAdvisor(provider(freshSnapshot(DAMPEN_ROWS)), "active");
    const setup = makeSetup();

    agent.dispatch("BTC", { type: "setup_detected", setup });

    expect(agent.getCoinState("BTC")).toBe("ENTERING");
    const orders = placeOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.setup.patternData.advisorSizeMultiplier).toBe(
      ADVISOR.dampenSizeMultiplier,
    );
    // Original setup must never be mutated — dampen acts on a shallow copy.
    expect(orders[0]?.setup).not.toBe(setup);
    expect(setup.patternData.advisorSizeMultiplier).toBeUndefined();

    const journals = advisorJournals();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.details).toMatchObject({
      applied: true,
      action: "dampen",
      sizeMultiplier: ADVISOR.dampenSizeMultiplier,
    });
  });

  // ── Active mode: allow ───────────────────────────────────────────────────

  it("active allow keeps place_order untouched and journals applied:false", () => {
    agent.setAdvisor(provider(freshSnapshot(ALLOW_ROWS)), "active");
    const setup = makeSetup();

    agent.dispatch("BTC", { type: "setup_detected", setup });

    expect(agent.getCoinState("BTC")).toBe("ENTERING");
    expect(placeOrders()).toHaveLength(1);
    expect(placeOrders()[0]?.setup).toBe(setup);

    const journals = advisorJournals();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.details).toMatchObject({
      applied: false,
      action: "allow",
      sizeMultiplier: 1,
    });
  });

  // ── Fail-open guards ─────────────────────────────────────────────────────

  it("fail-open: no provider set → order passes, no advisor journal", () => {
    agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });

    expect(agent.getCoinState("BTC")).toBe("ENTERING");
    expect(placeOrders()).toHaveLength(1);
    expect(advisorJournals()).toHaveLength(0);
  });

  it("fail-open: mode off disables the gate even with a provider", () => {
    agent.setAdvisor(provider(freshSnapshot(VETO_ROWS)), "off");

    agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });

    expect(agent.getCoinState("BTC")).toBe("ENTERING");
    expect(placeOrders()).toHaveLength(1);
    expect(advisorJournals()).toHaveLength(0);
  });

  it("fail-open: null snapshot → pass-through, no advisor journal", () => {
    agent.setAdvisor(provider(null), "active");

    agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });

    expect(agent.getCoinState("BTC")).toBe("ENTERING");
    expect(placeOrders()).toHaveLength(1);
    expect(advisorJournals()).toHaveLength(0);
  });

  it("fail-open: stale snapshot must not drive a veto", () => {
    agent.setAdvisor(provider(staleSnapshot(VETO_ROWS)), "active");

    agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });

    expect(agent.getCoinState("BTC")).toBe("ENTERING");
    expect(placeOrders()).toHaveLength(1);
    expect(advisorJournals()).toHaveLength(0);
  });

  it("gate is a no-op when no place_order action is emitted", () => {
    agent.setAdvisor(provider(freshSnapshot(VETO_ROWS)), "active");

    agent.dispatch("BTC", { type: "tick" });

    expect(agent.getCoinState("BTC")).toBe("IDLE");
    expect(advisorJournals()).toHaveLength(0);
  });

  // ── Bucket dimension threading ───────────────────────────────────────────

  it("threads regime + interval into the most specific bucket", () => {
    const rows = outcomeRows(12, 0, { regime: "BULL", timeframe: "1h" });
    agent.setAdvisor(provider(freshSnapshot(rows)), "active");
    const setup = makeSetup({ patternData: { regime: "BULL" } });

    agent.dispatch("BTC", { type: "setup_detected", setup });

    const journals = advisorJournals();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.details.bucketKey).toBe("smc-sd|BULL|long|1h");
    expect(agent.getCoinState("BTC")).toBe("IDLE"); // vetoed
  });

  it("invalid regime string falls back to the pattern|side bucket", () => {
    agent.setAdvisor(provider(freshSnapshot(VETO_ROWS)), "active");
    const setup = makeSetup({ patternData: { regime: "MOON" } });

    agent.dispatch("BTC", { type: "setup_detected", setup });

    const journals = advisorJournals();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.details.bucketKey).toBe("smc-sd|long");
  });
});

// ── Close-event PnL dedupe ───────────────────────────────────────────────────

describe("TradingAgent — close-event PnL dedupe", () => {
  let agent: TradingAgent;

  beforeEach(() => {
    resetAgent();
    agent = new TradingAgent();
  });

  /** Drive a coin into IN_POSITION with a known positionId. */
  function enterPosition(coin: string): void {
    agent.dispatch(coin, { type: "setup_detected", setup: makeSetup() });
    agent.dispatch(coin, {
      type: "order_filled",
      orderId: "ord-1",
      fillPrice: 50000,
      positionId: "pos-1",
    });
    expect(agent.getCoinState(coin)).toBe("IN_POSITION");
  }

  it("records PnL exactly once for a double-dispatched close (thesis path)", () => {
    enterPosition("BTC");

    // First close event (IN_POSITION → IDLE) carries the estimate.
    agent.dispatch("BTC", {
      type: "position_closed",
      positionId: "pos-1",
      closePrice: 49000,
      pnl: -100,
      reason: "thesis_deteriorated",
    });
    // Late duplicate (e.g. reconcile confirmation) — must not double-count.
    agent.dispatch("BTC", {
      type: "position_closed",
      positionId: "pos-1",
      closePrice: 49000,
      pnl: -100,
      reason: "thesis_deteriorated",
    });

    expect(agent.getCoinState("BTC")).toBe("IDLE");
    expect(agent.getGlobal().dailyPnl).toBe(-100);
    expect(agent.getCoinContext("BTC")?.consecutiveLosses).toBe(1);
  });

  it("still records PnL for a single-dispatch close", () => {
    enterPosition("ETH");

    agent.dispatch("ETH", {
      type: "trail_stop_hit",
      positionId: "pos-1",
      closePrice: 51000,
      pnl: 80,
    });

    expect(agent.getGlobal().dailyPnl).toBe(80);
  });
});

// ── EXITING stranding regression ─────────────────────────────────────────────

describe("TradingAgent — EXITING stranding regression", () => {
  let agent: TradingAgent;

  beforeEach(() => {
    resetAgent();
    agent = new TradingAgent();
  });

  function enterPosition(coin: string): void {
    agent.dispatch(coin, { type: "setup_detected", setup: makeSetup() });
    agent.dispatch(coin, {
      type: "order_filled",
      orderId: "ord-1",
      fillPrice: 50000,
      positionId: "pos-1",
    });
    expect(agent.getCoinState(coin)).toBe("IN_POSITION");
  }

  it("reconcile-detected close (single dispatch) returns the coin to IDLE and it can re-enter", () => {
    enterPosition("BTC");

    // Reconcile detects the position vanished (external close / liquidation):
    // exactly ONE position_closed — pre-fix this stranded the coin in EXITING.
    agent.dispatch("BTC", {
      type: "position_closed",
      positionId: "pos-1",
      closePrice: 48000,
      pnl: -200,
      reason: "exchange_position_closed",
    });

    expect(agent.getCoinState("BTC")).toBe("IDLE");

    // The coin must be able to trade again without a process restart.
    agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });
    expect(agent.getCoinState("BTC")).toBe("ENTERING");
  });

  it("agent-initiated close still passes through EXITING with retry capability", () => {
    enterPosition("ETH");

    agent.dispatch("ETH", {
      type: "setup_invalidated",
      setupId: "BTC|1h|smc-sd|long",
      reason: "zone_broken",
    });
    expect(agent.getCoinState("ETH")).toBe("EXITING");
    // positionId retained so the tick-retry path can re-close on timeout.
    expect(agent.getCoinContext("ETH")?.positionId).toBe("pos-1");

    agent.dispatch("ETH", {
      type: "position_closed",
      positionId: "pos-1",
      closePrice: 49500,
      pnl: -50,
      reason: "exchange_position_closed",
    });
    expect(agent.getCoinState("ETH")).toBe("IDLE");
  });

  it("EXITING with null positionId recovers via tick safety net", () => {
    enterPosition("SOL");

    // Force the residue scenario: invalidation puts the coin in EXITING,
    // then a trigger event nulls positionId without completing the state.
    agent.dispatch("SOL", {
      type: "setup_invalidated",
      setupId: "BTC|1h|smc-sd|long",
      reason: "zone_broken",
    });
    expect(agent.getCoinState("SOL")).toBe("EXITING");
    agent.dispatch("SOL", {
      type: "sl_hit",
      positionId: "pos-1",
      closePrice: 49000,
      pnl: -100,
    });

    // sl_hit completes the exit directly now; if any path still leaves
    // EXITING with a null positionId, the tick net must finish the exit.
    if (agent.getCoinState("SOL") === "EXITING") {
      agent.dispatch("SOL", { type: "tick" });
    }
    expect(agent.getCoinState("SOL")).toBe("IDLE");
  });
});
