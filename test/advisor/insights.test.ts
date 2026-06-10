import { describe, expect, it } from "bun:test";
import {
  generateInsights,
  insightImportance,
} from "../../src/advisor/insights.js";
import { aggregateOutcomes } from "../../src/advisor/stats.js";
import type { OutcomeRow } from "../../src/advisor/types.js";

const NOW = 1_750_000_000_000;

function outcome(partial: Partial<OutcomeRow>): OutcomeRow {
  return {
    pattern: "smc-sd",
    regime: "BULL",
    side: "long",
    timeframe: "1h",
    pnlR: 1,
    pnl: 100,
    ...partial,
  };
}

describe("generateInsights", () => {
  it("returns empty for null or empty snapshots", () => {
    expect(generateInsights(null)).toEqual([]);
    expect(generateInsights(aggregateOutcomes([], NOW))).toEqual([]);
  });

  it("emits insights only for buckets deviating from the global baseline", () => {
    // SIDEWAYS shorts lose constantly; BULL longs win constantly → both
    // deviate from the blended global rate.
    const winners = Array.from({ length: 15 }, () =>
      outcome({ regime: "BULL", side: "long", pnlR: 2, pnl: 100 }),
    );
    const losers = Array.from({ length: 15 }, () =>
      outcome({ regime: "SIDEWAYS", side: "short", pnlR: -1, pnl: -50 }),
    );
    const insights = generateInsights(aggregateOutcomes([...winners, ...losers], NOW));
    expect(insights.length).toBeGreaterThan(0);
    const keys = insights.map((i) => i.bucketKey);
    expect(keys).toContain("smc-sd|SIDEWAYS|short|1h");
    expect(keys).toContain("smc-sd|BULL|long|1h");
    const losing = insights.find((i) => i.bucketKey === "smc-sd|SIDEWAYS|short|1h");
    expect(losing && losing.winRateDelta).toBeLessThan(0);
    expect(losing?.content).toContain("underperforms");
  });

  it("skips buckets below min sample even when deviation is large", () => {
    const fewLosers = Array.from({ length: 3 }, () =>
      outcome({ regime: "VOLATILE", side: "short", pnlR: -1, pnl: -50 }),
    );
    const manyWinners = Array.from({ length: 20 }, () =>
      outcome({ regime: "BULL", side: "long", pnlR: 2, pnl: 100 }),
    );
    const insights = generateInsights(
      aggregateOutcomes([...fewLosers, ...manyWinners], NOW),
    );
    expect(
      insights.find((i) => i.bucketKey.includes("VOLATILE")),
    ).toBeUndefined();
  });

  it("sorts by absolute deviation, largest first", () => {
    const winners = Array.from({ length: 15 }, () =>
      outcome({ regime: "BULL", side: "long", pnlR: 2, pnl: 100 }),
    );
    const losers = Array.from({ length: 15 }, () =>
      outcome({ regime: "SIDEWAYS", side: "short", pnlR: -1, pnl: -50 }),
    );
    const insights = generateInsights(aggregateOutcomes([...winners, ...losers], NOW));
    for (let i = 1; i < insights.length; i++) {
      expect(Math.abs(insights[i - 1]?.winRateDelta ?? 0)).toBeGreaterThanOrEqual(
        Math.abs(insights[i]?.winRateDelta ?? 0),
      );
    }
  });
});

describe("insightImportance", () => {
  it("grows with deviation and caps below 0.9", () => {
    const small = insightImportance({
      bucketKey: "x",
      trades: 10,
      smoothedWinRate: 0.5,
      avgR: null,
      winRateDelta: 0.16,
      content: "",
    });
    const large = insightImportance({
      bucketKey: "y",
      trades: 10,
      smoothedWinRate: 0.1,
      avgR: null,
      winRateDelta: -0.6,
      content: "",
    });
    expect(small).toBeGreaterThan(0.5);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(0.85);
  });
});
