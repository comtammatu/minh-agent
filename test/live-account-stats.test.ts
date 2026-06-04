import { describe, expect, it } from "bun:test";
import { buildLiveWalletStats } from "../src/ui/live-account-stats.js";

describe("buildLiveWalletStats", () => {
  it("fills one canonical wallet with zeros when DB empty", () => {
    const s = buildLiveWalletStats([]);
    expect(s.wallets).toHaveLength(1);
    expect(s.tradeCount).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.wallets[0]?.label).toBe("smc-sd");
  });

  it("merges DB rows into the canonical wallet slot", () => {
    const s = buildLiveWalletStats([
      { walletLabel: "smc-sd", wins: 2, losses: 1, tradeCount: 3 },
    ]);
    const q = s.wallets.find((w) => w.label === "smc-sd");
    expect(q?.wins).toBe(2);
    expect(q?.losses).toBe(1);
    expect(q?.winRate).toBeCloseTo(2 / 3, 5);
  });
});
