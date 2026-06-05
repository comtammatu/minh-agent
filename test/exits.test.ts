/**
 * Exit strategy tests — SL/TP computation, position sizing, trailing, partial close.
 * Golden fixtures from Section 12 domain knowledge.
 */

import { describe, expect, it } from "bun:test";
import type { TrailingStopState } from "../src/agent/exits.js";
import {
  addSlippageBuffer,
  buildExitPlan,
  clampPositionSizeForMaxLeverage,
  computeAtrStop,
  computeCombinedStop,
  computeEntryLeverageForTargetMargin,
  computePartialCloseLevels,
  computePositionSize,
  computePositionSizeDetailed,
  computeRrTakeProfit,
  computeStructureStop,
  computeStructureTakeProfit,
  computeTrailingStop,
  isTrailingStopHit,
} from "../src/agent/exits.js";

// ─── computePositionSize ────────────────────────────────────────────────────

describe("computePositionSize", () => {
  it("Section 12 golden test: $10k account, 1% risk, 2% stop", () => {
    // Account $10,000, risk 1% = $100 max loss
    // Entry $100, SL $98 → stopDist = $2 per coin
    // Size = $100 / $2 = 50 coins
    const size = computePositionSize(10_000, 0.01, 100, 98);
    expect(size).toBe(50);
  });

  it("Section 12 golden test: wider stop → smaller size", () => {
    // Entry $100, SL $95 → stopDist = $5
    // Size = $100 / $5 = 20 coins
    const size = computePositionSize(10_000, 0.01, 100, 95);
    expect(size).toBe(20);
  });

  it("Section 12 golden test: very wide stop → very small size", () => {
    // Entry $100, SL $90 → stopDist = $10
    // Size = $100 / $10 = 10 coins
    const size = computePositionSize(10_000, 0.01, 100, 90);
    expect(size).toBe(10);
  });

  it("short side: SL above entry", () => {
    // Entry $100, SL $103 → stopDist = $3
    // Size = $100 / $3 = 33.33
    const size = computePositionSize(10_000, 0.01, 100, 103);
    expect(size).toBeCloseTo(33.333, 2);
  });

  it("returns 0 when stop distance is zero", () => {
    expect(computePositionSize(10_000, 0.01, 100, 100)).toBe(0);
  });

  it("returns 0 when entry price is zero", () => {
    expect(computePositionSize(10_000, 0.01, 0, 98)).toBe(0);
  });
});

// ─── clampPositionSizeForMaxLeverage ────────────────────────────────────────

describe("clampPositionSizeForMaxLeverage", () => {
  it("does not cap when notional fits margin budget at maxLev", () => {
    // $1k equity, 10% margin budget → $100 margin target; maxLev 5 → max notional $500
    const r = clampPositionSizeForMaxLeverage(1, 100, 1_000, 0.1, 5);
    expect(r.wasCapped).toBe(false);
    expect(r.sizeCoins).toBe(1);
  });

  it("caps when risk-based notional would need leverage above maxLev", () => {
    // sizeUsd = 2 × 100 = $200; max notional at 5x = 1000 × 0.1 × 5 = $500 → no cap
    // sizeUsd = 10 × 100 = $1000; max $500 → cap to 5 coins
    const r = clampPositionSizeForMaxLeverage(10, 100, 1_000, 0.1, 5);
    expect(r.wasCapped).toBe(true);
    expect(r.sizeCoins).toBe(5);
  });

  it("no-op when maxLeverage unknown", () => {
    const r = clampPositionSizeForMaxLeverage(100, 50, 1_000, 0.1, undefined);
    expect(r.wasCapped).toBe(false);
    expect(r.sizeCoins).toBe(100);
  });
});

// ─── computeEntryLeverageForTargetMargin ────────────────────────────────────

describe("computeEntryLeverageForTargetMargin", () => {
  it("matches setLeverage: ceil(sizeUsd / (account × targetMarginPct)), min 1", () => {
    // $1k account, 10% margin budget → $100 target margin; $500 notional → 5x
    expect(
      computeEntryLeverageForTargetMargin(500, 1_000, 0.1, undefined),
    ).toBe(5);
  });

  it("caps at maxLeverage", () => {
    expect(computeEntryLeverageForTargetMargin(900, 1_000, 0.1, 5)).toBe(5);
  });
});

// ─── computePositionSizeDetailed ────────────────────────────────────────────

describe("computePositionSizeDetailed", () => {
  it("good trade: moderate stop, moderate leverage", () => {
    // Entry $100, SL $98 → 2% stop → size = $100/0.02 = $5000 → 0.5x leverage
    const result = computePositionSizeDetailed(10_000, 0.01, 100, 98);
    expect(result.verdict).toBe("good");
    expect(result.sizeUsd).toBe(5_000);
    expect(result.sizeCoins).toBe(50);
    expect(result.leverage).toBe(0.5);
    expect(result.riskAmount).toBe(100);
  });

  it("skip: stop too wide (> 10%)", () => {
    // Entry $100, SL $85 → 15% stop
    const result = computePositionSizeDetailed(10_000, 0.01, 100, 85);
    expect(result.verdict).toBe("skip");
    expect(result.reason).toContain("stop too wide");
  });

  it("skip: zero stop distance", () => {
    const result = computePositionSizeDetailed(10_000, 0.01, 100, 100);
    expect(result.verdict).toBe("skip");
    expect(result.reason).toContain("zero stop");
  });

  it("skip: invalid input (zero account)", () => {
    const result = computePositionSizeDetailed(0, 0.01, 100, 98);
    expect(result.verdict).toBe("skip");
  });

  it("skip: position too small", () => {
    // Need sizeUsd < accountValue * 0.001
    // account=$10, risk=0.0001 (0.01%), entry=$100, sl=$91 → stopPct=9%
    // risk = 10 * 0.0001 = 0.001, sizeUsd = 0.001 / 0.09 ≈ 0.0111
    // minSize = 10 * 0.001 = 0.01 → 0.0111 > 0.01 → still not skip
    // account=$10, risk=0.00001, entry=$100, sl=$91
    // risk = 0.0001, sizeUsd = 0.0001 / 0.09 ≈ 0.00111, minSize = 0.01 → skip!
    const result = computePositionSizeDetailed(10, 0.00001, 100, 91);
    expect(result.verdict).toBe("skip");
    expect(result.reason).toContain("too small");
  });

  it("warn: high leverage", () => {
    // Entry $100, SL $99.8 → 0.2% stop → sizeUsd = 100/0.002 = 50000 → 5x leverage
    // MAX_LEVERAGE_WARN = 5.0, 5x not > 5 → good
    // Need > 5x: SL $99.85 → 0.15% stop → 100/0.0015 = 66666 → 6.67x
    const result = computePositionSizeDetailed(10_000, 0.01, 100, 99.85);
    expect(result.verdict).toBe("warn");
    expect(result.reason).toContain("leverage");
  });
});

// ─── Stop Loss ──────────────────────────────────────────────────────────────

describe("computeStructureStop", () => {
  it("long: stop below zone bottom minus ATR buffer", () => {
    // zoneBottom=98, ATR=2, buffer=1.0 → atrBuffer=2.0 → stop=96.0
    const result = computeStructureStop("long", 98, 100, 2, 100);
    expect(result.price).toBeCloseTo(96.0, 4);
    expect(result.method).toBe("structure");
    expect(result.atrBuffer).toBeCloseTo(2.0, 4);
    expect(result.distancePct).toBeCloseTo(0.04, 3);
  });

  it("short: stop above zone top plus ATR buffer", () => {
    // zoneTop=102, ATR=2, buffer=1.0 → atrBuffer=2.0 → stop=104.0
    const result = computeStructureStop("short", 100, 102, 2, 100);
    expect(result.price).toBeCloseTo(104.0, 4);
    expect(result.method).toBe("structure");
    expect(result.distancePct).toBeCloseTo(0.04, 3);
  });
});

describe("computeAtrStop", () => {
  it("long: standard 1.5x ATR stop", () => {
    // Entry=100, ATR=2, mult=1.5 → stop = 100-3 = 97
    const result = computeAtrStop("long", 100, 2, 1.5);
    expect(result.price).toBe(97);
    expect(result.method).toBe("atr");
    expect(result.distancePct).toBeCloseTo(0.03, 4);
  });

  it("short: standard 1.5x ATR stop", () => {
    // Entry=100, ATR=2, mult=1.5 → stop = 100+3 = 103
    const result = computeAtrStop("short", 100, 2, 1.5);
    expect(result.price).toBe(103);
    expect(result.method).toBe("atr");
  });

  it("uses default multiplier (1.5)", () => {
    const result = computeAtrStop("long", 100, 2);
    expect(result.price).toBe(97);
  });
});

describe("computeCombinedStop", () => {
  it("long: uses structure when tighter than ATR", () => {
    // Structure: zoneBottom=98, ATR buffer=1 → 97
    // ATR: entry=100, ATR=2, mult=1.5 → 97
    // Both equal here → 97
    const result = computeCombinedStop("long", 98, 100, 100, 2, 1.5);
    expect(result.price).toBe(97);
    expect(result.method).toBe("combined");
  });

  it("long: ATR stop tighter, clamped at zone bottom", () => {
    // Structure: zoneBottom=95, ATR buffer=1 → 94
    // ATR: entry=100, ATR=2, mult=1.5 → 97
    // ATR(97) is tighter but clamped to min(97, zoneBottom=95) → 95
    // max(94, 95) = 95
    const result = computeCombinedStop("long", 95, 100, 100, 2, 1.5);
    expect(result.price).toBe(95);
  });

  it("short: uses structure when tighter than ATR", () => {
    // Structure: zoneTop=102, ATR buffer=1 → 103
    // ATR: entry=100, ATR=2, mult=1.5 → 103
    const result = computeCombinedStop("short", 100, 102, 100, 2, 1.5);
    expect(result.price).toBe(103);
  });
});

// ─── Take Profit ────────────────────────────────────────────────────────────

describe("computeRrTakeProfit", () => {
  it("long: 2R take profit", () => {
    // Entry=100, SL=97, stopDist=3, target RR=2 → TP = 100+6 = 106
    const result = computeRrTakeProfit("long", 100, 97, 2);
    expect(result.price).toBe(106);
    expect(result.rr).toBe(2);
    expect(result.distancePct).toBeCloseTo(0.06, 4);
  });

  it("short: 2R take profit", () => {
    // Entry=100, SL=103, stopDist=3, target RR=2 → TP = 100-6 = 94
    const result = computeRrTakeProfit("short", 100, 103, 2);
    expect(result.price).toBe(94);
    expect(result.rr).toBe(2);
  });

  it("1R take profit (breakeven + 1 risk)", () => {
    const result = computeRrTakeProfit("long", 100, 97, 1);
    expect(result.price).toBe(103);
  });
});

describe("computeStructureTakeProfit", () => {
  it("computes R:R from structure target", () => {
    // Entry=100, SL=97, target=110 → risk=3, reward=10 → RR=3.33
    const result = computeStructureTakeProfit("long", 100, 97, 110);
    expect(result.price).toBe(110);
    expect(result.rr).toBeCloseTo(3.333, 2);
  });

  it("zero stop distance → RR=0", () => {
    const result = computeStructureTakeProfit("long", 100, 100, 110);
    expect(result.rr).toBe(0);
  });
});

// ─── Trailing Stop ──────────────────────────────────────────────────────────

describe("computeTrailingStop", () => {
  const config = { activationPct: 0.01, trailPct: 0.005 };

  it("long: not active below activation threshold", () => {
    // Entry=100, current=100.5 → +0.5% < 1%
    const state = computeTrailingStop("long", 100, 100.5, null, config);
    expect(state.active).toBe(false);
    expect(state.highestPrice).toBe(100.5);
  });

  it("long: activates at threshold", () => {
    // Entry=100, current=101 → +1% = 1%
    const state = computeTrailingStop("long", 100, 101, null, config);
    expect(state.active).toBe(true);
    // Trail stop = 101 * (1 - 0.005) = 100.495
    expect(state.currentStopPrice).toBeCloseTo(100.495, 2);
    expect(state.highestPrice).toBe(101);
  });

  it("long: trail follows higher prices", () => {
    const prev: TrailingStopState = {
      active: true,
      highestPrice: 102,
      currentStopPrice: 101.49,
    };
    // Price moves to 104
    const state = computeTrailingStop("long", 100, 104, prev, config);
    expect(state.active).toBe(true);
    expect(state.highestPrice).toBe(104);
    // Trail stop = 104 * 0.995 = 103.48
    expect(state.currentStopPrice).toBeCloseTo(103.48, 2);
  });

  it("long: trail does not move down on pullback", () => {
    const prev: TrailingStopState = {
      active: true,
      highestPrice: 105,
      currentStopPrice: 104.475,
    };
    // Price pulls back to 103 (still above entry so still active)
    const state = computeTrailingStop("long", 100, 103, prev, config);
    expect(state.active).toBe(true);
    expect(state.highestPrice).toBe(105); // keeps highest
    // Trail stop based on highest (105) not current
    expect(state.currentStopPrice).toBeCloseTo(104.475, 2);
  });

  it("short: activates and trails lower prices", () => {
    // Entry=100, current=98.5 → +1.5% profit (short)
    const state = computeTrailingStop("short", 100, 98.5, null, config);
    expect(state.active).toBe(true);
    expect(state.highestPrice).toBe(98.5); // lowest price for short
    // Trail stop = 98.5 * (1 + 0.005) = 98.9925
    expect(state.currentStopPrice).toBeCloseTo(98.9925, 2);
  });
});

describe("isTrailingStopHit", () => {
  it("long: hit when price <= stop", () => {
    const state: TrailingStopState = {
      active: true,
      highestPrice: 105,
      currentStopPrice: 104.475,
    };
    expect(isTrailingStopHit("long", 104, state)).toBe(true);
    expect(isTrailingStopHit("long", 104.475, state)).toBe(true);
    expect(isTrailingStopHit("long", 105, state)).toBe(false);
  });

  it("short: hit when price >= stop", () => {
    const state: TrailingStopState = {
      active: true,
      highestPrice: 95,
      currentStopPrice: 95.475,
    };
    expect(isTrailingStopHit("short", 96, state)).toBe(true);
    expect(isTrailingStopHit("short", 95.475, state)).toBe(true);
    expect(isTrailingStopHit("short", 95, state)).toBe(false);
  });

  it("not hit when inactive", () => {
    const state: TrailingStopState = {
      active: false,
      highestPrice: 100,
      currentStopPrice: 0,
    };
    expect(isTrailingStopHit("long", 50, state)).toBe(false);
  });
});

// ─── Partial Close ──────────────────────────────────────────────────────────

describe("computePartialCloseLevels", () => {
  it("long: two levels at 1.5R and 3R (default config)", () => {
    // Entry=100, SL=97 → stopDist=3
    // Level 1: 100 + 3×1.5 = 104.5, close 50%, no breakeven move
    // Level 2: 100 + 3×3.0 = 109, close remaining 50%
    const levels = computePartialCloseLevels("long", 100, 97);
    expect(levels).toHaveLength(2);
    expect(levels[0].targetPrice).toBe(104.5);
    expect(levels[0].closePct).toBe(0.5);
    expect(levels[0].newSlPrice).toBeUndefined(); // moveSlToBreakeven=false
    expect(levels[1].targetPrice).toBe(109);
    expect(levels[1].closePct).toBe(0.5);
  });

  it("short: two levels below entry (default config)", () => {
    // Entry=100, SL=103 → stopDist=3
    // Level 1: 100 - 3×1.5 = 95.5, Level 2: 100 - 3×3.0 = 91
    const levels = computePartialCloseLevels("short", 100, 103);
    expect(levels).toHaveLength(2);
    expect(levels[0].targetPrice).toBe(95.5);
    expect(levels[1].targetPrice).toBe(91);
  });

  it("custom config", () => {
    const config = {
      firstTpRatio: 1.5,
      firstClosePct: 0.33,
      moveSlToBreakeven: false,
      secondTpRatio: 3.0,
    };
    const levels = computePartialCloseLevels("long", 100, 97, config);
    // stopDist=3, first TP at 1.5R = 100+4.5=104.5
    expect(levels[0].targetPrice).toBe(104.5);
    expect(levels[0].closePct).toBe(0.33);
    expect(levels[0].newSlPrice).toBeUndefined();
    // second TP at 3R = 100+9=109
    expect(levels[1].targetPrice).toBe(109);
    expect(levels[1].closePct).toBeCloseTo(0.67, 2);
  });

  it("zero stop distance → empty", () => {
    expect(computePartialCloseLevels("long", 100, 100)).toHaveLength(0);
  });
});

// ─── buildExitPlan ──────────────────────────────────────────────────────────

describe("buildExitPlan", () => {
  it("builds complete exit plan for a long trade", () => {
    const plan = buildExitPlan("long", 100, 98, 100, 2, 10_000, 0.01, 2.0);
    expect(plan).not.toBeNull();
    if (!plan) return;

    // Stop loss: combined method
    expect(plan.stopLoss.method).toBe("combined");
    expect(plan.stopLoss.price).toBeLessThan(100);

    // Take profit: 2R above entry
    expect(plan.takeProfit.price).toBeGreaterThan(100);
    expect(plan.takeProfit.rr).toBe(2);

    // Position size
    expect(plan.positionSize.sizeUsd).toBeGreaterThan(0);
    expect(plan.positionSize.verdict).not.toBe("skip");

    // Partial closes
    expect(plan.partialCloses).toHaveLength(2);

    // Trailing config
    expect(plan.trailingConfig.activationPct).toBeGreaterThan(0);
    expect(plan.trailingConfig.trailPct).toBeGreaterThan(0);
  });

  it("builds complete exit plan for a short trade", () => {
    const plan = buildExitPlan("short", 100, 100, 102, 2, 10_000, 0.01, 2.0);
    expect(plan).not.toBeNull();
    if (!plan) return;

    expect(plan.stopLoss.price).toBeGreaterThan(100);
    expect(plan.takeProfit.price).toBeLessThan(100);
  });

  it("returns null for invalid inputs", () => {
    expect(buildExitPlan("long", 0, 98, 100, 2, 10_000)).toBeNull();
    expect(buildExitPlan("long", 100, 98, 100, 0, 10_000)).toBeNull();
    expect(buildExitPlan("long", 100, 98, 100, 2, 0)).toBeNull();
  });
});

// ─── addSlippageBuffer ──────────────────────────────────────────────────────

describe("addSlippageBuffer", () => {
  it("long: widens stop down", () => {
    // Stop at 97, buffer 0.2% → 97 * 0.998 = 96.806
    const result = addSlippageBuffer("long", 97, 0.002);
    expect(result).toBeCloseTo(96.806, 2);
  });

  it("short: widens stop up", () => {
    // Stop at 103, buffer 0.2% → 103 * 1.002 = 103.206
    const result = addSlippageBuffer("short", 103, 0.002);
    expect(result).toBeCloseTo(103.206, 2);
  });
});
