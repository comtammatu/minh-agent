/**
 * Invalidation Bridge tests (Sprint 2 S8).
 *
 * Updated for canonical single-context routing:
 *   - setup matching is coin + setup id only
 *   - stats aggregate globally instead of by strategy bucket
 *   - legacy strategy-prefixed setup ids are accepted for coin parsing only
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { ActiveSetup } from "../types.js";
import {
  InvalidationBridge,
  parseCoinFromSetupId,
  resetInvalidationBridge,
} from "./invalidation-bridge.js";
import { resetAgent, TradingAgent } from "./trading-agent.js";
import type { AgentAction } from "./types.js";

function makeSetup(overrides: Partial<ActiveSetup> = {}): ActiveSetup {
  return {
    id: "BTC|1h|order-block|long",
    coin: "BTC",
    interval: "1h",
    type: "minh",
    side: "long",
    confidence: 0.75,
    entryPrice: 50000,
    slPrice: 49000,
    tpPrice: 52000,
    patternData: {},
    detectedAt: Date.now(),
    detectedAtBar: 0,
    expiresAtBar: 100,
    confluenceGrade: "A",
    confluenceCount: 4,
    exchange: "HL",
    ...overrides,
  };
}

describe("parseCoinFromSetupId", () => {
  it("extracts coin from canonical setup ids", () => {
    expect(parseCoinFromSetupId("BTC|1h|order-block|long")).toBe("BTC");
    expect(parseCoinFromSetupId("ETH|15m|fvg|short")).toBe("ETH");
    expect(parseCoinFromSetupId("SOL|4h|spring|long")).toBe("SOL");
  });

  it("extracts coin from legacy strategy-prefixed setup ids", () => {
    expect(parseCoinFromSetupId("minh:BTC|1h|minh")).toBe("BTC");
    expect(parseCoinFromSetupId("alpha:ETH|15m|minh")).toBe("ETH");
  });

  it("returns null for invalid setup ids", () => {
    expect(parseCoinFromSetupId("")).toBeNull();
    expect(parseCoinFromSetupId("BTC")).toBeNull();
    expect(parseCoinFromSetupId("BT")).toBeNull();
  });
});

describe("InvalidationBridge", () => {
  let bridge: InvalidationBridge;
  let agent: TradingAgent;

  beforeEach(() => {
    resetAgent();
    resetInvalidationBridge();
    bridge = new InvalidationBridge();
    agent = new TradingAgent();
  });

  describe("setup id matching", () => {
    it("acts when invalidated setupId matches the active setup", () => {
      const setup = makeSetup();
      agent.dispatch("BTC", { type: "setup_detected", setup });
      expect(agent.getCoinState("BTC")).toBe("ENTERING");

      const record = bridge.onInvalidation(
        "BTC|1h|order-block|long",
        "zone-broken",
        agent,
      );
      expect(record.matched).toBe(true);
      expect(record.actionTaken).toBe("cancel_order");
      expect(agent.getCoinState("BTC")).toBe("IDLE");
    });

    it("skips non-matching setup ids on the same coin", () => {
      agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });

      const record = bridge.onInvalidation(
        "BTC|15m|fvg|short",
        "fvg-filled",
        agent,
      );
      expect(record.matched).toBe(false);
      expect(record.actionTaken).toBe("none");
      expect(agent.getCoinState("BTC")).toBe("ENTERING");
    });

    it("skips when the coin has no active setup", () => {
      const record = bridge.onInvalidation(
        "BTC|1h|order-block|long",
        "zone-broken",
        agent,
      );
      expect(record.matched).toBe(false);
      expect(record.actionTaken).toBe("none");
    });
  });

  describe("state-aware dispatch", () => {
    it("maps ENTERING invalidations to cancel_order", () => {
      agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });
      const actions: AgentAction[] = [];
      agent.onAction((action) => actions.push(action));

      const record = bridge.onInvalidation(
        "BTC|1h|order-block|long",
        "zone-broken",
        agent,
      );
      expect(record.coinState).toBe("ENTERING");
      expect(record.actionTaken).toBe("cancel_order");
      expect(record.matched).toBe(true);
      expect(
        actions.some(
          (action) =>
            action.type === "log_journal" && action.eventType === "invalidate",
        ),
      ).toBe(true);
    });

    it("maps IN_POSITION invalidations to close_position", () => {
      agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });
      agent.dispatch("BTC", {
        type: "order_filled",
        orderId: "ord-1",
        fillPrice: 50000,
        positionId: "pos-1",
      });
      expect(agent.getCoinState("BTC")).toBe("IN_POSITION");

      const record = bridge.onInvalidation(
        "BTC|1h|order-block|long",
        "zone-broken",
        agent,
      );
      expect(record.matched).toBe(true);
      expect(record.actionTaken).toBe("close_position");
      expect(agent.getCoinState("BTC")).toBe("EXITING");
    });
  });

  describe("pipeline integration", () => {
    it("connects to EventEmitter and records matched invalidations", () => {
      const emitter = new EventEmitter();
      agent.subscribeToPipeline(emitter);
      bridge.connect(emitter, agent);

      emitter.emit("setup", makeSetup());
      emitter.emit("invalidation", "BTC|1h|order-block|long", "zone-broken");

      expect(agent.getCoinState("BTC")).toBe("IDLE");
      const history = bridge.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]?.matched).toBe(true);
      expect(history[0]?.actionTaken).toBe("cancel_order");
    });

    it("treats non-matching invalidations as no-ops", () => {
      const emitter = new EventEmitter();
      agent.subscribeToPipeline(emitter);
      bridge.connect(emitter, agent);

      emitter.emit("setup", makeSetup());
      emitter.emit("invalidation", "ETH|15m|fvg|short", "fvg-filled");

      expect(agent.getCoinState("BTC")).toBe("ENTERING");
      expect(bridge.getHistory()[0]?.matched).toBe(false);
    });
  });

  describe("history and stats", () => {
    it("computes global counters without per-strategy buckets", () => {
      agent.dispatch("BTC", { type: "setup_detected", setup: makeSetup() });

      bridge.onInvalidation("BTC|1h|order-block|long", "zone-broken", agent);
      bridge.onInvalidation("ETH|15m|fvg|short", "fvg-filled", agent);
      bridge.onInvalidation("SOL|4h|spring|long", "spring-failed", agent);

      const stats = bridge.getStats();
      expect(stats.total).toBe(3);
      expect(stats.matched).toBe(1);
      expect(stats.skipped).toBe(2);
      expect(stats.parseFailed).toBe(0);
      expect(stats.actions.cancel_order).toBe(1);
      expect(stats.actions.none).toBe(2);
    });

    it("counts malformed setup ids as parse failures", () => {
      bridge.onInvalidation("", "bad-id", agent);
      const stats = bridge.getStats();
      expect(stats.total).toBe(1);
      expect(stats.parseFailed).toBe(1);
      expect(stats.matched).toBe(0);
      expect(stats.skipped).toBe(0);
    });

    it("clearHistory resets the audit buffer", () => {
      bridge.onInvalidation("BTC|1h|order-block|long", "zone-broken", agent);
      expect(bridge.getHistory()).toHaveLength(1);

      bridge.clearHistory();
      expect(bridge.getHistory()).toHaveLength(0);
    });
  });
});
