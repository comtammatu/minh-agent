import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DMS_DEADLINE_MS,
  DMS_REFRESH_MS,
  getExecutionMode,
  isDmsEnabled,
  isPaperMode,
} from "../../src/config.js";

/**
 * HL dead-man-switch gating + operational-budget invariants.
 *
 * These are policy tests: they don't boot the runtime. They lock in the
 * config-level contract that runtime/app.ts depends on so the arming logic
 * stays inside HL's published limits (≥5s schedule minimum, ≤10 ops/day).
 */
describe("DMS arming policy", () => {
  let origExchange: string | undefined;
  let origExecutionMode: string | undefined;
  let origPaper: string | undefined;

  beforeEach(() => {
    origExchange = process.env.ACTIVE_EXCHANGE;
    origExecutionMode = process.env.EXECUTION_MODE;
    origPaper = process.env.PAPER_TRADE;
  });

  afterEach(() => {
    if (origExchange === undefined) delete process.env.ACTIVE_EXCHANGE;
    else process.env.ACTIVE_EXCHANGE = origExchange;
    if (origExecutionMode === undefined) delete process.env.EXECUTION_MODE;
    else process.env.EXECUTION_MODE = origExecutionMode;
    if (origPaper === undefined) delete process.env.PAPER_TRADE;
    else process.env.PAPER_TRADE = origPaper;
  });

  describe("getExecutionMode", () => {
    it("defaults to paper when execution env is unset", () => {
      delete process.env.EXECUTION_MODE;
      delete process.env.PAPER_TRADE;
      expect(getExecutionMode()).toBe("paper");
      expect(isPaperMode()).toBe(true);
    });

    it("returns paper or live from EXECUTION_MODE", () => {
      process.env.EXECUTION_MODE = "paper";
      process.env.PAPER_TRADE = "false";
      expect(getExecutionMode()).toBe("paper");
      expect(isPaperMode()).toBe(true);

      process.env.EXECUTION_MODE = "live";
      process.env.PAPER_TRADE = "true";
      expect(getExecutionMode()).toBe("live");
      expect(isPaperMode()).toBe(false);
    });

    it("treats invalid EXECUTION_MODE as paper safe default", () => {
      process.env.EXECUTION_MODE = "real-money";
      process.env.PAPER_TRADE = "false";
      expect(getExecutionMode()).toBe("paper");
      expect(isPaperMode()).toBe(true);
    });

    it("keeps PAPER_TRADE=true as legacy paper alias", () => {
      delete process.env.EXECUTION_MODE;
      process.env.PAPER_TRADE = "true";
      expect(getExecutionMode()).toBe("paper");
      expect(isPaperMode()).toBe(true);
    });

    it("keeps PAPER_TRADE=false as legacy live alias", () => {
      delete process.env.EXECUTION_MODE;
      process.env.PAPER_TRADE = "false";
      expect(getExecutionMode()).toBe("live");
      expect(isPaperMode()).toBe(false);
    });

    it("treats any other PAPER_TRADE value as paper", () => {
      delete process.env.EXECUTION_MODE;
      process.env.PAPER_TRADE = "no";
      expect(isPaperMode()).toBe(true);
      process.env.PAPER_TRADE = "0";
      expect(isPaperMode()).toBe(true);
      process.env.PAPER_TRADE = "";
      expect(isPaperMode()).toBe(true);
    });
  });

  describe("isDmsEnabled", () => {
    it("true when HL + EXECUTION_MODE=live", () => {
      process.env.ACTIVE_EXCHANGE = "HL";
      process.env.EXECUTION_MODE = "live";
      expect(isDmsEnabled()).toBe(true);
    });

    it("false when HL + paper (safe default)", () => {
      process.env.ACTIVE_EXCHANGE = "HL";
      delete process.env.EXECUTION_MODE;
      delete process.env.PAPER_TRADE;
      expect(isDmsEnabled()).toBe(false);
    });

    it("false when BB even in live mode (no HL DMS for Bybit)", () => {
      process.env.ACTIVE_EXCHANGE = "BB";
      process.env.EXECUTION_MODE = "live";
      expect(isDmsEnabled()).toBe(false);
    });

    it("false when ACTIVE_EXCHANGE is unset", () => {
      delete process.env.ACTIVE_EXCHANGE;
      process.env.EXECUTION_MODE = "live";
      expect(isDmsEnabled()).toBe(false);
    });
  });

  describe("cadence invariants", () => {
    it("deadline exceeds HL's 5s minimum by a wide margin", () => {
      expect(DMS_DEADLINE_MS).toBeGreaterThan(5_000);
    });

    it("refresh fires before the deadline expires", () => {
      expect(DMS_REFRESH_MS).toBeLessThan(DMS_DEADLINE_MS);
    });

    it("refresh leaves slack ≥ HL's 5s schedule minimum before the deadline", () => {
      expect(DMS_DEADLINE_MS - DMS_REFRESH_MS).toBeGreaterThanOrEqual(5_000);
    });

    it("daily refresh budget stays under HL's 10 ops/day cap", () => {
      const opsPerDay = (24 * 60 * 60 * 1000) / DMS_REFRESH_MS;
      expect(opsPerDay).toBeLessThanOrEqual(10);
    });
  });
});
