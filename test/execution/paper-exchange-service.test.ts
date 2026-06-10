import { describe, expect, it } from "bun:test";
import { SIMULATED_ACCOUNT } from "../../src/config.js";
import { PaperExchangeService } from "../../src/execution/paper-exchange-service.js";

describe("PaperExchangeService", () => {
  it("fills submitted paper orders immediately at the submitted price", async () => {
    const svc = new PaperExchangeService("HL");
    await svc.init();

    const result = await svc.placeOrder({
      coin: "BTC",
      side: "long",
      type: "limit",
      price: 50_000,
      size: 0.1,
      reduceOnly: false,
      cloid: "0x00000000000000000000000000000001",
    });

    expect(result).toMatchObject({
      success: true,
      oid: null,
      avgPx: 50_000,
      totalSz: 0.1,
      status: "filled",
      error: null,
    });
    expect(result.rawOrderId).toStartWith("paper:HL:");

    const byCloid = await svc.getFillAggregateByCloid(
      "0x00000000000000000000000000000001",
      "BTC",
    );
    expect(byCloid).toEqual({
      avgPx: 50_000,
      totalSz: 0.1,
      isFilled: true,
    });
    expect(
      await svc.getFillAggregateByOrderId(result.rawOrderId ?? "", "BTC"),
    ).toEqual(byCloid);
  });

  it("accepts protective and cancel calls as no-op successes", async () => {
    const svc = new PaperExchangeService("BB");
    await svc.init();

    await expect(
      svc.placeTrigger({
        coin: "ETH",
        side: "short",
        triggerPrice: 2_900,
        size: 1,
        isMarket: true,
        tpsl: "sl",
      }),
    ).resolves.toMatchObject({
      success: true,
      status: "paper_trigger_noop",
      error: null,
    });
    await expect(svc.cancelAllOpenOrders()).resolves.toMatchObject({
      success: true,
      status: "paper_cancel_all_noop",
      error: null,
    });
    await expect(
      svc.scheduleCancel(Date.now() + 60_000),
    ).resolves.toMatchObject({
      success: true,
      status: "paper_schedule_cancel_noop",
      error: null,
    });
  });

  it("returns simulated account state without exchange credentials", async () => {
    const svc = new PaperExchangeService("HL");
    const account = await svc.getAccountState();

    expect(svc.getWalletAddress()).toBe("paper");
    expect(svc.getAccountAddress()).toBe("paper");
    expect(account.effectiveBalance).toBe(SIMULATED_ACCOUNT);
    expect(account.withdrawable).toBe(SIMULATED_ACCOUNT);
    expect(await svc.getPositions()).toEqual([]);
    expect(await svc.getOpenOrders()).toEqual([]);
  });
});
