/**
 * Tests for new SMC functions: premiumDiscount + oteZone.
 * Sprint 1 Step 1 additions.
 */

import { describe, expect, it } from "bun:test";
import { oteZone, premiumDiscount } from "../src/indicators/smc.js";

// ─── premiumDiscount ──────────────────────────────────────────────────────────

describe("premiumDiscount", () => {
  const H = 100;
  const L = 80;
  // eq = 90, premium > 90.45 (90 * 1.005), discount < 89.55 (90 * 0.995)

  it("returns premium when price above equilibrium + buffer", () => {
    expect(premiumDiscount(H, L, 95)).toBe("premium");
    expect(premiumDiscount(H, L, 100)).toBe("premium");
  });

  it("returns discount when price below equilibrium - buffer", () => {
    expect(premiumDiscount(H, L, 85)).toBe("discount");
    expect(premiumDiscount(H, L, 80)).toBe("discount");
  });

  it("returns equilibrium when price within buffer of midpoint", () => {
    expect(premiumDiscount(H, L, 90)).toBe("equilibrium");
    expect(premiumDiscount(H, L, 90.3)).toBe("equilibrium");
    expect(premiumDiscount(H, L, 89.6)).toBe("equilibrium");
  });

  it("returns correct zone at buffer boundary (floating point aware)", () => {
    // eq = 90, premium threshold = 90 * 1.005 = 90.449999...
    // 90.45 > 90.449... → premium (floating point)
    expect(premiumDiscount(H, L, 90.45)).toBe("premium");
    // 90.44 < 90.449... → equilibrium
    expect(premiumDiscount(H, L, 90.44)).toBe("equilibrium");
    // discount threshold = 90 * 0.995 = 89.55
    // 89.55 is NOT < 89.55 → equilibrium
    expect(premiumDiscount(H, L, 89.55)).toBe("equilibrium");
    // 89.54 < 89.55 → discount
    expect(premiumDiscount(H, L, 89.54)).toBe("discount");
  });

  it("returns equilibrium when swingHigh <= swingLow (invalid range)", () => {
    expect(premiumDiscount(80, 100, 90)).toBe("equilibrium");
    expect(premiumDiscount(90, 90, 90)).toBe("equilibrium");
  });
});

// ─── oteZone ──────────────────────────────────────────────────────────────────

describe("oteZone", () => {
  it("returns correct OTE for bullish impulse (B > A)", () => {
    // A=100, B=200, range=100
    // OTE top = 200 - 100*0.62 = 138
    // OTE bottom = 200 - 100*0.79 = 121
    const result = oteZone(100, 200);
    expect(result).not.toBeNull();
    expect(result?.top).toBeCloseTo(138, 5);
    expect(result?.bottom).toBeCloseTo(121, 5);
    // top > bottom
    expect(result?.top).toBeGreaterThan(result?.bottom);
  });

  it("returns correct OTE for bearish impulse (B < A)", () => {
    // A=200, B=100, range=100
    // OTE top = 100 + 100*0.79 = 179
    // OTE bottom = 100 + 100*0.62 = 162
    const result = oteZone(200, 100);
    expect(result).not.toBeNull();
    expect(result?.top).toBeCloseTo(179, 5);
    expect(result?.bottom).toBeCloseTo(162, 5);
    expect(result?.top).toBeGreaterThan(result?.bottom);
  });

  it("returns null when swingA === swingB (no range)", () => {
    expect(oteZone(100, 100)).toBeNull();
  });

  it("OTE zone is within the impulse range", () => {
    // Bullish: OTE should be between swingA and swingB
    const bull = oteZone(50, 150)!;
    expect(bull.top).toBeGreaterThan(50);
    expect(bull.bottom).toBeGreaterThan(50);
    expect(bull.top).toBeLessThan(150);
    expect(bull.bottom).toBeLessThan(150);

    // Bearish: OTE should be between swingB and swingA
    const bear = oteZone(150, 50)!;
    expect(bear.top).toBeGreaterThan(50);
    expect(bear.bottom).toBeGreaterThan(50);
    expect(bear.top).toBeLessThan(150);
    expect(bear.bottom).toBeLessThan(150);
  });

  it("handles small ranges", () => {
    const result = oteZone(100, 101);
    expect(result).not.toBeNull();
    expect(result?.top).toBeGreaterThan(result?.bottom);
  });
});
