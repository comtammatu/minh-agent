import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAdvisorCache, resetAdvisorCache } from "../../src/advisor/index.js";
import { ADVISOR, getAdvisorMode } from "../../src/config.js";

/**
 * Advisor runtime-wiring gating + cadence invariants.
 *
 * Policy tests for config-level contracts that runtime/app.ts depends on when
 * wiring the advisor (setAdvisor injection, refresh-on-close + periodic refresh).
 */
describe("Advisor wiring policy", () => {
  describe("getAdvisorMode", () => {
    let origMode: string | undefined;

    beforeEach(() => {
      origMode = process.env.ADVISOR_MODE;
    });

    afterEach(() => {
      if (origMode === undefined) delete process.env.ADVISOR_MODE;
      else process.env.ADVISOR_MODE = origMode;
    });

    it("defaults to shadow when ADVISOR_MODE is unset", () => {
      delete process.env.ADVISOR_MODE;
      expect(getAdvisorMode()).toBe("shadow");
    });

    it("returns off | shadow | active from ADVISOR_MODE (case-insensitive)", () => {
      process.env.ADVISOR_MODE = "off";
      expect(getAdvisorMode()).toBe("off");
      process.env.ADVISOR_MODE = "shadow";
      expect(getAdvisorMode()).toBe("shadow");
      process.env.ADVISOR_MODE = "ACTIVE";
      expect(getAdvisorMode()).toBe("active");
    });

    it("treats invalid ADVISOR_MODE as shadow (observable, never enforcing)", () => {
      process.env.ADVISOR_MODE = "aggressive";
      expect(getAdvisorMode()).toBe("shadow");
      process.env.ADVISOR_MODE = "";
      expect(getAdvisorMode()).toBe("shadow");
    });
  });

  describe("cadence invariants", () => {
    it("stats refresh interval is a valid setInterval cadence", () => {
      expect(ADVISOR.refreshMs).toBeGreaterThan(0);
    });

    it("periodic refresh outpaces the staleness window", () => {
      expect(ADVISOR.refreshMs).toBeLessThan(ADVISOR.staleAfterMs);
    });
  });

  describe("fail-open precondition", () => {
    afterEach(() => {
      resetAdvisorCache();
    });

    it("snapshot is null (pass-through) before the first refresh completes", () => {
      resetAdvisorCache();
      const cache = getAdvisorCache();
      expect(cache.getSnapshot()).toBeNull();
    });

    it("getAdvisorCache returns a process-wide singleton", () => {
      resetAdvisorCache();
      expect(getAdvisorCache()).toBe(getAdvisorCache());
    });
  });
});
