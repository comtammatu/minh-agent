import { describe, expect, it } from "bun:test";
import {
  aggregateOutcomes,
  bucketKeysFor,
  evaluateSetup,
  isSnapshotFresh,
} from "../../src/advisor/stats.js";
import type { OutcomeRow, SetupDims } from "../../src/advisor/types.js";
import { ADVISOR } from "../../src/config.js";

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

/** n losing trades followed by m winning trades in the default bucket. */
function rows(losses: number, wins: number): OutcomeRow[] {
  return [
    ...Array.from({ length: losses }, () => outcome({ pnlR: -1, pnl: -50 })),
    ...Array.from({ length: wins }, () => outcome({ pnlR: 2, pnl: 100 })),
  ];
}

const DIMS: SetupDims = {
  pattern: "smc-sd",
  side: "long",
  regime: "BULL",
  interval: "1h",
};

describe("bucketKeysFor", () => {
  it("returns most-specific-first hierarchy when all dims present", () => {
    expect(bucketKeysFor(DIMS)).toEqual([
      "smc-sd|BULL|long|1h",
      "smc-sd|BULL|long",
      "smc-sd|long",
    ]);
  });

  it("skips levels whose dimensions are missing", () => {
    expect(bucketKeysFor({ ...DIMS, regime: null })).toEqual(["smc-sd|long"]);
    expect(bucketKeysFor({ ...DIMS, interval: null })).toEqual([
      "smc-sd|BULL|long",
      "smc-sd|long",
    ]);
  });
});

describe("aggregateOutcomes", () => {
  it("aggregates wins/losses into every hierarchy level plus global", () => {
    const snap = aggregateOutcomes(rows(3, 7), NOW);
    expect(snap.sampleSize).toBe(10);
    expect(snap.global?.trades).toBe(10);
    expect(snap.global?.wins).toBe(7);
    const l1 = snap.buckets.get("smc-sd|BULL|long|1h");
    expect(l1?.trades).toBe(10);
    expect(l1?.losses).toBe(3);
    expect(snap.buckets.get("smc-sd|long")?.trades).toBe(10);
  });

  it("applies Laplace smoothing to win rate", () => {
    const snap = aggregateOutcomes(rows(0, 4), NOW);
    const stats = snap.buckets.get("smc-sd|BULL|long|1h");
    // (4 + 1) / (4 + 1 + 1) — never a hard 100%
    expect(stats?.smoothedWinRate).toBeCloseTo(5 / 6, 10);
  });

  it("falls back to pnl sign when pnlR is missing and skips unusable rows", () => {
    const snap = aggregateOutcomes(
      [
        outcome({ pnlR: null, pnl: -10 }),
        outcome({ pnlR: null, pnl: 25 }),
        outcome({ pnlR: null, pnl: 0 }), // unusable — no signal
        outcome({ pnlR: null, pnl: null }), // unusable
      ],
      NOW,
    );
    expect(snap.sampleSize).toBe(2);
    expect(snap.global?.wins).toBe(1);
    expect(snap.global?.avgR).toBeNull();
  });

  it("returns empty snapshot for no rows", () => {
    const snap = aggregateOutcomes([], NOW);
    expect(snap.global).toBeNull();
    expect(snap.buckets.size).toBe(0);
  });
});

describe("evaluateSetup", () => {
  it("passes through when snapshot or dims are null", () => {
    expect(evaluateSetup(null, aggregateOutcomes([], NOW)).action).toBe(
      "allow",
    );
    const verdict = evaluateSetup(DIMS, null);
    expect(verdict.action).toBe("allow");
    expect(verdict.bucketKey).toBeNull();
  });

  it("passes through below min sample (cold start)", () => {
    const snap = aggregateOutcomes(rows(ADVISOR.minSample - 1, 0), NOW);
    const verdict = evaluateSetup(DIMS, snap);
    expect(verdict.action).toBe("allow");
    expect(verdict.bucketKey).toBeNull();
  });

  it("vetoes a bucket with terrible win rate and negative avgR", () => {
    const snap = aggregateOutcomes(rows(12, 0), NOW);
    const verdict = evaluateSetup(DIMS, snap);
    expect(verdict.action).toBe("veto");
    expect(verdict.bucketKey).toBe("smc-sd|BULL|long|1h");
    expect(verdict.sampleSize).toBe(12);
  });

  it("does not veto a low win rate bucket whose avgR is positive", () => {
    // 2 wins at +8R, 10 losses at -1R → smoothed WR 3/14 ≈ 0.21 but avgR > 0
    const losers = Array.from({ length: 10 }, () =>
      outcome({ pnlR: -1, pnl: -50 }),
    );
    const winners = Array.from({ length: 2 }, () =>
      outcome({ pnlR: 8, pnl: 400 }),
    );
    const snap = aggregateOutcomes([...losers, ...winners], NOW);
    const verdict = evaluateSetup(DIMS, snap);
    expect(verdict.action).toBe("dampen");
    expect(verdict.sizeMultiplier).toBe(ADVISOR.dampenSizeMultiplier);
  });

  it("dampens a mediocre bucket", () => {
    // 4 wins / 8 losses → smoothed 5/14 ≈ 0.36 < dampenWinRate 0.4
    const snap = aggregateOutcomes(rows(8, 4), NOW);
    const verdict = evaluateSetup(DIMS, snap);
    expect(verdict.action).toBe("dampen");
  });

  it("allows a healthy bucket", () => {
    const snap = aggregateOutcomes(rows(4, 8), NOW);
    const verdict = evaluateSetup(DIMS, snap);
    expect(verdict.action).toBe("allow");
    expect(verdict.sizeMultiplier).toBe(1);
    expect(verdict.bucketKey).toBe("smc-sd|BULL|long|1h");
  });

  it("falls back to a broader bucket when the specific one is too small", () => {
    // L1 bucket (BEAR|short|4h) tiny, but pattern|side bucket large via other rows
    const broad = Array.from({ length: 12 }, () =>
      outcome({
        regime: "BULL",
        timeframe: "1h",
        side: "short",
        pnlR: -1,
        pnl: -50,
      }),
    );
    const snap = aggregateOutcomes(broad, NOW);
    const verdict = evaluateSetup(
      { pattern: "smc-sd", side: "short", regime: "BEAR", interval: "4h" },
      snap,
    );
    expect(verdict.bucketKey).toBe("smc-sd|short");
    expect(verdict.action).toBe("veto");
  });
});

describe("isSnapshotFresh", () => {
  it("rejects null and stale snapshots, accepts fresh ones", () => {
    expect(isSnapshotFresh(null, NOW)).toBe(false);
    const snap = aggregateOutcomes([], NOW);
    expect(isSnapshotFresh(snap, NOW + ADVISOR.staleAfterMs - 1)).toBe(true);
    expect(isSnapshotFresh(snap, NOW + ADVISOR.staleAfterMs + 1)).toBe(false);
  });
});
