import { describe, expect, it } from "bun:test";
import type { HoldoutResult, TrialResult } from "./optimize.js";
import {
  inferScanMode,
  rankHoldoutResults,
  scoreHoldoutRobustness,
  selectTopN,
} from "./optimize.js";

describe("inferScanMode", () => {
  it("maps 15m to 15m_drilldown", () => {
    expect(inferScanMode("15m")).toBe("15m_drilldown");
  });

  it("maps 1h to 1h_same_tf", () => {
    expect(inferScanMode("1h")).toBe("1h_same_tf");
  });

  it("maps 5m to 5m_micro", () => {
    expect(inferScanMode("5m")).toBe("5m_micro");
  });

  it("maps 4h to 4h_poi", () => {
    expect(inferScanMode("4h")).toBe("4h_poi");
  });

  it("returns unknown for unlisted intervals", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(inferScanMode("1d" as any)).toBe("unknown");
  });
});

function makeTrial(partial: Partial<TrialResult>): TrialResult {
  return {
    trialIndex: partial.trialIndex ?? 0,
    params: partial.params ?? {},
    oosPF: partial.oosPF ?? 0,
    oosExpectancy: partial.oosExpectancy ?? 0,
    maxDD: partial.maxDD ?? 0,
    winRate: partial.winRate ?? 0,
    tradeCount: partial.tradeCount ?? 0,
    numWindows: partial.numWindows ?? 0,
    durationMs: partial.durationMs ?? 0,
    error: partial.error,
    tradesByMode: partial.tradesByMode,
  };
}

function makeHoldout(partial: Partial<HoldoutResult>): HoldoutResult {
  return {
    ...makeTrial(partial),
    holdoutPF: partial.holdoutPF ?? 0,
    holdoutMaxDD: partial.holdoutMaxDD ?? 0,
    holdoutTrades: partial.holdoutTrades ?? 0,
    holdoutTradesByMode: partial.holdoutTradesByMode,
  };
}

describe("selectTopN", () => {
  it("prefers robust OOS sample size over tiny high-PF samples", () => {
    const tinyHighPf = makeTrial({
      trialIndex: 1,
      oosPF: 4.0,
      tradeCount: 10,
      maxDD: 0.05,
    });
    const broaderSample = makeTrial({
      trialIndex: 2,
      oosPF: 2.0,
      tradeCount: 50,
      maxDD: 0.05,
    });

    const top = selectTopN([tinyHighPf, broaderSample], 2);
    expect(top[0]?.trialIndex).toBe(2);
    expect(top[1]?.trialIndex).toBe(1);
  });
});

describe("holdout anti-overfit ranking", () => {
  it("prioritizes robust holdout pass over non-pass even with higher raw score", () => {
    const robustPass = makeHoldout({
      trialIndex: 10,
      oosPF: 4.0,
      tradeCount: 50,
      holdoutPF: 1.2,
      holdoutTrades: 45,
      holdoutMaxDD: 0.1,
    });
    const nonPassHighRaw = makeHoldout({
      trialIndex: 11,
      oosPF: 1.6,
      tradeCount: 40,
      holdoutPF: 1.8,
      holdoutTrades: 12,
      holdoutMaxDD: 0.05,
    });

    const ranked = rankHoldoutResults([nonPassHighRaw, robustPass]);
    expect(ranked[0]?.trialIndex).toBe(10);
    expect(ranked[1]?.trialIndex).toBe(11);
  });

  it("penalizes OOS/holdout divergence in objective score", () => {
    const overfitLike = makeHoldout({
      trialIndex: 20,
      oosPF: 5.0,
      holdoutPF: 0.5,
      holdoutTrades: 40,
      holdoutMaxDD: 0.05,
    });
    const stableLike = makeHoldout({
      trialIndex: 21,
      oosPF: 1.0,
      holdoutPF: 0.5,
      holdoutTrades: 40,
      holdoutMaxDD: 0.05,
    });

    expect(scoreHoldoutRobustness(stableLike)).toBeGreaterThan(
      scoreHoldoutRobustness(overfitLike),
    );
  });
});
