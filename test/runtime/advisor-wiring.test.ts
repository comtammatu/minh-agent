import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAdvisorCache, resetAdvisorCache } from "../../src/advisor/index.js";
import { ADVISOR, getAdvisorMode } from "../../src/config.js";

/**
 * Advisor runtime-wiring gating + cadence invariants.
 *
 * These are policy tests: they don't boot the runtime. They lock in the
 * config-level contract that runtime/app.ts depends on when wiring the
 * advisor (step 9: setAdvisor injection, refresh-on-close + periodic
 * refresh, insight job) so the wiring stays fail-open and the periodic
 * refresh keeps the snapshot inside the staleness window.
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
      // An idle runtime (no trade closes) must keep the snapshot fresh via the
      // interval alone — otherwise the advisor silently disables itself
      // between trades once isSnapshotFresh starts failing.
      expect(ADVISOR.refreshMs).toBeLessThan(ADVISOR.staleAfterMs);
    });

    it("insight job cadence is valid and not hotter than the stats refresh", () => {
      expect(ADVISOR.insightIntervalMs).toBeGreaterThan(0);
      // The insight job reads the cache snapshot — the snapshot must have been
      // refreshed at least once between consecutive insight runs.
      expect(ADVISOR.insightIntervalMs).toBeGreaterThanOrEqual(
        ADVISOR.refreshMs,
      );
    });
  });

  describe("fail-open precondition", () => {
    afterEach(() => {
      resetAdvisorCache();
    });

    it("snapshot is null (pass-through) before the first refresh completes", () => {
      // runtime/app.ts fires `void advisorCache.refresh()` without awaiting —
      // boot must not be delayed, so the entry path can observe the cache
      // before any stats load. getSnapshot() must be synchronous and null-safe.
      resetAdvisorCache();
      const cache = getAdvisorCache();
      expect(cache.getSnapshot()).toBeNull();
    });

    it("getAdvisorCache returns a process-wide singleton", () => {
      // setAdvisor injection + refresh intervals + insight job all reference
      // the same instance — a per-call instance would split the snapshot.
      resetAdvisorCache();
      expect(getAdvisorCache()).toBe(getAdvisorCache());
    });
  });
});
