import { describe, expect, it } from "bun:test";
import { RISK } from "../config.js";
import {
  getCorrelationExposure,
  getCorrelationGroups,
  shouldBlockCorrelatedEntry,
} from "./correlation-guard.js";

// ─── getCorrelationGroups ──────────────────────────────────────────────────

describe("getCorrelationGroups", () => {
  it("returns groups for a known coin", () => {
    const groups = getCorrelationGroups("BTC");
    expect(groups).toContain("btc-ecosystem");
  });

  it("returns multiple groups for a coin in several groups", () => {
    // WIF is in both sol-ecosystem and meme
    const groups = getCorrelationGroups("WIF");
    expect(groups).toContain("sol-ecosystem");
    expect(groups).toContain("meme");
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for unknown coin", () => {
    const groups = getCorrelationGroups("UNKNOWN_COIN_XYZ");
    expect(groups).toEqual([]);
  });

  it("returns groups for L1 coin", () => {
    const groups = getCorrelationGroups("AVAX");
    expect(groups).toContain("l1");
  });
});

// ─── shouldBlockCorrelatedEntry ─────────────────────────────────────────────

describe("shouldBlockCorrelatedEntry", () => {
  it("allows entry when no open positions", () => {
    const result = shouldBlockCorrelatedEntry("BTC", []);
    expect(result.blocked).toBe(false);
  });

  it("allows entry for unknown coin regardless of open positions", () => {
    const result = shouldBlockCorrelatedEntry("UNKNOWN_COIN", [
      "BTC",
      "ETH",
      "SOL",
    ]);
    expect(result.blocked).toBe(false);
  });

  it("allows entry when correlated positions under limit", () => {
    // maxCorrelatedPositions = 2, one BTC-ecosystem coin open
    const result = shouldBlockCorrelatedEntry("STX", ["BTC"]);
    expect(result.blocked).toBe(false);
  });

  it("blocks entry when correlated positions at limit", () => {
    // BTC + STX = 2 in btc-ecosystem, adding ORDI would be 3 > 2
    const result = shouldBlockCorrelatedEntry("ORDI", ["BTC", "STX"]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("btc-ecosystem");
    expect(result.blockedGroups).toContain("btc-ecosystem");
  });

  it("allows entry when positions are in different groups", () => {
    // BTC (btc-ecosystem) and UNI (defi) — no group overlap with SOL
    const result = shouldBlockCorrelatedEntry("SOL", ["BTC", "UNI"]);
    expect(result.blocked).toBe(false);
  });

  it("does not count the coin itself as an existing position", () => {
    // Edge case: if somehow BTC appears in openPositionCoins and we try BTC again
    // (shouldn't happen with 1-per-coin rule, but guard handles it)
    const result = shouldBlockCorrelatedEntry("BTC", ["BTC"]);
    expect(result.blocked).toBe(false);
  });

  it("blocks when any shared group exceeds limit", () => {
    // WIF is in both sol-ecosystem and meme
    // SOL + JUP fill sol-ecosystem, DOGE + PEPE fill meme
    const result = shouldBlockCorrelatedEntry("WIF", [
      "SOL",
      "JUP",
      "DOGE",
      "PEPE",
    ]);
    expect(result.blocked).toBe(true);
    expect(result.blockedGroups.length).toBeGreaterThanOrEqual(1);
  });

  it("reports multiple blocked groups when applicable", () => {
    // WIF is in sol-ecosystem + meme, both full
    const result = shouldBlockCorrelatedEntry("WIF", [
      "SOL",
      "JUP",
      "DOGE",
      "PEPE",
    ]);
    expect(result.blocked).toBe(true);
    // Should report both groups
    expect(result.blockedGroups).toContain("sol-ecosystem");
    expect(result.blockedGroups).toContain("meme");
  });

  it("respects custom maxPerGroup parameter", () => {
    // With maxPerGroup=1, even one correlated position blocks
    const result = shouldBlockCorrelatedEntry("STX", ["BTC"], 1);
    expect(result.blocked).toBe(true);
  });

  it("allows with higher maxPerGroup", () => {
    // With maxPerGroup=5, two positions don't block
    const result = shouldBlockCorrelatedEntry("ORDI", ["BTC", "STX"], 5);
    expect(result.blocked).toBe(false);
  });

  it("handles open positions with no group overlap", () => {
    // AAVE (defi) open, entering AVAX (l1) — no overlap
    const result = shouldBlockCorrelatedEntry("AVAX", ["AAVE"]);
    expect(result.blocked).toBe(false);
  });

  it("reason includes the limit number", () => {
    const result = shouldBlockCorrelatedEntry("ORDI", ["BTC", "STX"]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(`${RISK.maxCorrelatedPositions}`);
  });
});

// ─── getCorrelationExposure ─────────────────────────────────────────────────

describe("getCorrelationExposure", () => {
  it("returns empty for no open positions", () => {
    const exposure = getCorrelationExposure([]);
    expect(Object.keys(exposure)).toHaveLength(0);
  });

  it("returns correct exposure for single group", () => {
    const exposure = getCorrelationExposure(["BTC", "STX"]);
    expect(exposure["btc-ecosystem"]).toBeDefined();
    expect(exposure["btc-ecosystem"].count).toBe(2);
    expect(exposure["btc-ecosystem"].coins).toContain("BTC");
    expect(exposure["btc-ecosystem"].coins).toContain("STX");
  });

  it("returns exposure across multiple groups", () => {
    const exposure = getCorrelationExposure(["BTC", "ETH", "SOL"]);
    expect(exposure["btc-ecosystem"]?.count).toBe(1);
    expect(exposure["eth-ecosystem"]?.count).toBe(1);
    expect(exposure["sol-ecosystem"]?.count).toBe(1);
  });

  it("counts coin in multiple groups", () => {
    // WIF is in sol-ecosystem + meme
    const exposure = getCorrelationExposure(["WIF"]);
    expect(exposure["sol-ecosystem"]?.coins).toContain("WIF");
    expect(exposure.meme?.coins).toContain("WIF");
  });

  it("does not include groups with zero positions", () => {
    const exposure = getCorrelationExposure(["BTC"]);
    expect(exposure.defi).toBeUndefined();
    expect(exposure.meme).toBeUndefined();
  });
});
