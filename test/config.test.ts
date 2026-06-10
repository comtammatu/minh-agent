import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  assertDashboardBindingAllowed,
  BYBIT_STATIC_COINS,
  getActiveExchange,
  getDefaultCoins,
  tryGetActiveExchange,
} from "../src/config.js";

describe("getDefaultCoins", () => {
  it("BB returns BYBIT_STATIC_COINS", () => {
    const coins = getDefaultCoins("BB");
    expect(coins).toEqual(BYBIT_STATIC_COINS);
    expect(coins.length).toBeGreaterThan(10);
    expect(coins).toContain("BTC");
    expect(coins).toContain("BNB"); // not on HL
  });

  it("HL returns empty (dynamic)", () => {
    const coins = getDefaultCoins("HL");
    expect(coins).toEqual([]);
  });
});

describe("getActiveExchange", () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.ACTIVE_EXCHANGE;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.ACTIVE_EXCHANGE;
    } else {
      process.env.ACTIVE_EXCHANGE = origEnv;
    }
  });

  it("throws when ACTIVE_EXCHANGE not set", () => {
    delete process.env.ACTIVE_EXCHANGE;
    expect(() => getActiveExchange()).toThrow("ACTIVE_EXCHANGE");
  });

  it("throws on unknown value", () => {
    process.env.ACTIVE_EXCHANGE = "OKX";
    expect(() => getActiveExchange()).toThrow("OKX");
  });

  it("returns HL when set to HL", () => {
    process.env.ACTIVE_EXCHANGE = "HL";
    expect(getActiveExchange()).toBe("HL");
  });

  it("returns BB when set to BB", () => {
    process.env.ACTIVE_EXCHANGE = "BB";
    expect(getActiveExchange()).toBe("BB");
  });
});

describe("tryGetActiveExchange", () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.ACTIVE_EXCHANGE;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.ACTIVE_EXCHANGE;
    } else {
      process.env.ACTIVE_EXCHANGE = origEnv;
    }
  });

  it("returns null when ACTIVE_EXCHANGE is not set", () => {
    delete process.env.ACTIVE_EXCHANGE;
    expect(tryGetActiveExchange()).toBeNull();
  });

  it("returns null on unknown value", () => {
    process.env.ACTIVE_EXCHANGE = "OKX";
    expect(tryGetActiveExchange()).toBeNull();
  });

  it("returns HL when set to HL", () => {
    process.env.ACTIVE_EXCHANGE = "HL";
    expect(tryGetActiveExchange()).toBe("HL");
  });

  it("returns BB when set to BB", () => {
    process.env.ACTIVE_EXCHANGE = "BB";
    expect(tryGetActiveExchange()).toBe("BB");
  });
});

describe("assertDashboardBindingAllowed", () => {
  let origRemoteEnabled: string | undefined;
  let origAuthToken: string | undefined;

  beforeEach(() => {
    origRemoteEnabled = process.env.DASHBOARD_REMOTE_ENABLED;
    origAuthToken = process.env.DASHBOARD_AUTH_TOKEN;
  });

  afterEach(() => {
    if (origRemoteEnabled === undefined) {
      delete process.env.DASHBOARD_REMOTE_ENABLED;
    } else {
      process.env.DASHBOARD_REMOTE_ENABLED = origRemoteEnabled;
    }
    if (origAuthToken === undefined) {
      delete process.env.DASHBOARD_AUTH_TOKEN;
    } else {
      process.env.DASHBOARD_AUTH_TOKEN = origAuthToken;
    }
  });

  it("allows localhost bindings", () => {
    expect(() => assertDashboardBindingAllowed("127.0.0.1")).not.toThrow();
    expect(() => assertDashboardBindingAllowed("localhost")).not.toThrow();
    expect(() => assertDashboardBindingAllowed("::1")).not.toThrow();
  });

  it("rejects non-localhost binding without remote auth opt-in", () => {
    delete process.env.DASHBOARD_REMOTE_ENABLED;
    delete process.env.DASHBOARD_AUTH_TOKEN;
    expect(() => assertDashboardBindingAllowed("0.0.0.0")).toThrow(
      "Refusing dashboard bind",
    );
  });

  it("allows non-localhost binding only with remote opt-in and auth token", () => {
    process.env.DASHBOARD_REMOTE_ENABLED = "true";
    process.env.DASHBOARD_AUTH_TOKEN = "secret";
    expect(() => assertDashboardBindingAllowed("0.0.0.0")).not.toThrow();
  });
});
