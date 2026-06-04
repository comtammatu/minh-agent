import { beforeEach, describe, expect, it } from "bun:test";
import {
  computeComponentStatus,
  computeMemoryStatus,
  computeOverallStatus,
  HealthMonitor,
  resetHealthMonitor,
} from "../../src/agent/self-healing.js";
import type { ComponentHealth } from "../../src/agent/types.js";
import { HEALTH } from "../../src/config.js";

describe("self-healing", () => {
  // ── Pure Functions ────────────────────────────────────────────────────────

  describe("computeComponentStatus", () => {
    const now = Date.now();

    function health(overrides: Partial<ComponentHealth> = {}): ComponentHealth {
      return {
        status: "ok",
        lastSuccessAt: now,
        lastErrorAt: 0,
        lastError: null,
        consecutiveErrors: 0,
        ...overrides,
      };
    }

    it("returns ok when no errors and recent success", () => {
      expect(computeComponentStatus(health(), 60_000, now)).toBe("ok");
    });

    it("returns degraded at 3 consecutive errors", () => {
      expect(
        computeComponentStatus(health({ consecutiveErrors: 3 }), 60_000, now),
      ).toBe("degraded");
    });

    it("returns critical at 5 consecutive errors", () => {
      expect(
        computeComponentStatus(health({ consecutiveErrors: 5 }), 60_000, now),
      ).toBe("critical");
    });

    it("returns degraded when stale (no recent success)", () => {
      const staleHealth = health({ lastSuccessAt: now - 120_000 });
      expect(computeComponentStatus(staleHealth, 60_000, now)).toBe("degraded");
    });

    it("ok when just within staleness threshold", () => {
      const recentHealth = health({ lastSuccessAt: now - 59_999 });
      expect(computeComponentStatus(recentHealth, 60_000, now)).toBe("ok");
    });

    it("critical beats degraded (5 errors + stale)", () => {
      const badHealth = health({
        consecutiveErrors: 5,
        lastSuccessAt: now - 120_000,
      });
      expect(computeComponentStatus(badHealth, 60_000, now)).toBe("critical");
    });
  });

  describe("computeOverallStatus", () => {
    it("ok when all ok", () => {
      expect(computeOverallStatus(["ok", "ok", "ok"])).toBe("ok");
    });

    it("degraded when any degraded", () => {
      expect(computeOverallStatus(["ok", "degraded", "ok"])).toBe("degraded");
    });

    it("critical when any critical", () => {
      expect(computeOverallStatus(["ok", "degraded", "critical"])).toBe(
        "critical",
      );
    });

    it("critical beats degraded", () => {
      expect(computeOverallStatus(["degraded", "critical"])).toBe("critical");
    });
  });

  describe("computeMemoryStatus", () => {
    it("ok for normal RSS", () => {
      expect(computeMemoryStatus(100 * 1024 * 1024)).toBe("ok"); // 100MB
    });

    it("degraded at warning threshold", () => {
      expect(computeMemoryStatus(HEALTH.rssWarnBytes)).toBe("degraded");
    });

    it("critical at critical threshold", () => {
      expect(computeMemoryStatus(HEALTH.rssCriticalBytes)).toBe("critical");
    });

    it("ok just below warning", () => {
      expect(computeMemoryStatus(HEALTH.rssWarnBytes - 1)).toBe("ok");
    });
  });

  // ── HealthMonitor ─────────────────────────────────────────────────────────

  describe("HealthMonitor", () => {
    let monitor: HealthMonitor;

    beforeEach(() => {
      resetHealthMonitor();
      monitor = new HealthMonitor();
    });

    it("starts with all components ok", () => {
      const report = monitor.getReport();
      expect(report.overall).toBe("ok");
      expect(report.components.feed.status).toBe("ok");
      expect(report.components.db.status).toBe("ok");
      expect(report.components.exchange.status).toBe("ok");
    });

    it("recordSuccess resets consecutive errors", () => {
      monitor.recordError("feed", "timeout");
      monitor.recordError("feed", "timeout");
      expect(monitor.getComponentHealth("feed").consecutiveErrors).toBe(2);

      monitor.recordSuccess("feed");
      expect(monitor.getComponentHealth("feed").consecutiveErrors).toBe(0);
      expect(monitor.getComponentHealth("feed").status).toBe("ok");
    });

    it("recordError increments consecutive errors", () => {
      monitor.recordError("db", "connection lost");
      expect(monitor.getComponentHealth("db").consecutiveErrors).toBe(1);
      expect(monitor.getComponentHealth("db").lastError).toBe(
        "connection lost",
      );

      monitor.recordError("db", "connection lost again");
      expect(monitor.getComponentHealth("db").consecutiveErrors).toBe(2);
    });

    it("degrades component after 3 errors", () => {
      monitor.recordError("exchange", "err1");
      monitor.recordError("exchange", "err2");
      monitor.recordError("exchange", "err3");
      expect(monitor.getComponentHealth("exchange").status).toBe("degraded");
    });

    it("marks critical after 5 errors", () => {
      for (let i = 0; i < 5; i++) {
        monitor.recordError("exchange", `err${i}`);
      }
      expect(monitor.getComponentHealth("exchange").status).toBe("critical");
    });

    it("report reflects overall degraded when one component degrades", () => {
      for (let i = 0; i < 3; i++) {
        monitor.recordError("db", "err");
      }
      const report = monitor.getReport();
      expect(report.overall).toBe("degraded");
    });

    it("report includes uptime and rssBytes", () => {
      const report = monitor.getReport();
      expect(report.uptime).toBeGreaterThanOrEqual(0);
      expect(report.rssBytes).toBeGreaterThan(0);
    });

    it("getComponentHealth returns a copy (no mutation leak)", () => {
      const h1 = monitor.getComponentHealth("feed");
      h1.consecutiveErrors = 999;
      const h2 = monitor.getComponentHealth("feed");
      expect(h2.consecutiveErrors).toBe(0);
    });

    it("independent component tracking", () => {
      monitor.recordError("feed", "stale");
      monitor.recordError("feed", "stale");
      monitor.recordError("feed", "stale");
      monitor.recordSuccess("db");
      monitor.recordSuccess("exchange");

      expect(monitor.getComponentHealth("feed").status).toBe("degraded");
      expect(monitor.getComponentHealth("db").status).toBe("ok");
      expect(monitor.getComponentHealth("exchange").status).toBe("ok");
    });
  });
});
