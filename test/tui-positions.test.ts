import { describe, expect, it } from "bun:test";
import type {
  ExchangePositionSnapshot,
  PositionState,
} from "../src/agent/types.js";
import { mergeExchangeAndTrackedForTui } from "../src/ui/tui-positions.js";

function baseTracked(
  overrides: Partial<PositionState> &
    Pick<PositionState, "positionId" | "coin">,
): PositionState {
  return {
    positionId: overrides.positionId,
    coin: overrides.coin,
    side: overrides.side ?? "long",
    entryPrice: overrides.entryPrice ?? 100,
    currentSize: overrides.currentSize ?? 1,
    originalSize: overrides.originalSize ?? 1,
    slPrice: overrides.slPrice ?? 90,
    tpPrice: overrides.tpPrice ?? 120,
    entryOrderId: overrides.entryOrderId ?? "oid-1",
    leverage: overrides.leverage ?? 5,
    trailingState: overrides.trailingState ?? null,
    partialClosesFired: overrides.partialClosesFired ?? [],
    lastSyncAt: overrides.lastSyncAt ?? 0,
    openedAt: overrides.openedAt ?? 0,
  };
}

describe("mergeExchangeAndTrackedForTui", () => {
  it("shows HL-only positions when monitor is empty", () => {
    const exchange: ExchangePositionSnapshot[] = [
      {
        coin: "BTC",
        size: 0.05,
        entryPrice: 50_000,
        unrealizedPnl: 10,
        liquidationPrice: 40_000,
        leverage: 10,
      },
    ];
    const out = mergeExchangeAndTrackedForTui(new Map(), exchange);
    expect(out.size).toBe(1);
    const row = out.get("hl:minh:BTC");
    expect(row?.exchangeOnly).toBe(true);
    expect(row?.currentSize).toBe(0.05);
  });

  it("enriches exchange row from tracked when coin matches", () => {
    const tracked = new Map<string, PositionState>([
      [
        "p1",
        baseTracked({
          positionId: "p1",
          coin: "ETH",
          side: "short",
          slPrice: 3100,
          tpPrice: 2800,
        }),
      ],
    ]);
    const exchange: ExchangePositionSnapshot[] = [
      {
        coin: "ETH",
        size: -2,
        entryPrice: 3000,
        unrealizedPnl: -5,
        liquidationPrice: null,
        leverage: 3,
      },
    ];
    const out = mergeExchangeAndTrackedForTui(tracked, exchange);
    expect(out.size).toBe(1);
    const row = out.get("p1");
    expect(row?.exchangeOnly).toBe(false);
    expect(row?.currentSize).toBe(2);
    expect(row?.slPrice).toBe(3100);
    expect(row?.tpPrice).toBe(2800);
  });

  it("keeps tracked only rows when exchange snapshot is stale empty", () => {
    const tracked = new Map<string, PositionState>([
      ["p1", baseTracked({ positionId: "p1", coin: "SOL" })],
    ]);
    const out = mergeExchangeAndTrackedForTui(tracked, []);
    expect(out.size).toBe(1);
    expect(out.get("p1")?.coin).toBe("SOL");
  });
});
