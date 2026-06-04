import { describe, expect, test } from "bun:test";
import type { AgentAction } from "../../src/agent/types.js";
import { shouldSound } from "../../src/ui/sound.js";

// ─── shouldSound ────────────────────────────────────────────────────────

describe("shouldSound", () => {
  test("non-journal action → false", () => {
    const action: AgentAction = { type: "none" };
    expect(shouldSound(action)).toBe(false);
  });

  test("signal grade A+ → true", () => {
    const action: AgentAction = {
      type: "log_journal",
      eventType: "signal",
      coin: "BTC",
      details: { grade: "A+", confidence: 0.9 },
    };
    expect(shouldSound(action)).toBe(true);
  });

  test("signal grade A → true", () => {
    const action: AgentAction = {
      type: "log_journal",
      eventType: "signal",
      coin: "BTC",
      details: { grade: "A", confidence: 0.8 },
    };
    expect(shouldSound(action)).toBe(true);
  });

  test("signal grade B → true", () => {
    const action: AgentAction = {
      type: "log_journal",
      eventType: "signal",
      coin: "BTC",
      details: { grade: "B", confidence: 0.6 },
    };
    expect(shouldSound(action)).toBe(true);
  });

  test("signal grade C → false", () => {
    const action: AgentAction = {
      type: "log_journal",
      eventType: "signal",
      coin: "BTC",
      details: { grade: "C", confidence: 0.3 },
    };
    expect(shouldSound(action)).toBe(false);
  });

  test("signal no grade → false", () => {
    const action: AgentAction = {
      type: "log_journal",
      eventType: "signal",
      coin: "BTC",
      details: { confidence: 0.5 },
    };
    expect(shouldSound(action)).toBe(false);
  });

  test("circuit_break → true", () => {
    const action: AgentAction = {
      type: "log_journal",
      eventType: "circuit_break",
      coin: "*",
      details: { reason: "daily_loss" },
    };
    expect(shouldSound(action)).toBe(true);
  });

  test("enter → false", () => {
    const action: AgentAction = {
      type: "log_journal",
      eventType: "enter",
      coin: "ETH",
      details: { fillPrice: 3500 },
    };
    expect(shouldSound(action)).toBe(false);
  });

  test("exit → false", () => {
    const action: AgentAction = {
      type: "log_journal",
      eventType: "exit",
      coin: "SOL",
      details: { pnl: 10 },
    };
    expect(shouldSound(action)).toBe(false);
  });

  test("skip → false", () => {
    const action: AgentAction = {
      type: "log_journal",
      eventType: "skip",
      coin: "BTC",
      details: { reason: "low grade" },
    };
    expect(shouldSound(action)).toBe(false);
  });

  test("watch action (not journal) → false", () => {
    const action: AgentAction = {
      type: "watch",
      setup: {} as AgentAction extends { type: "watch" }
        ? AgentAction["setup"]
        : never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
    } as any;
    expect(shouldSound(action)).toBe(false);
  });
});
