import { describe, expect, it } from "bun:test";
import {
  calculateDelay,
  is429,
  is503,
  isRetryableExchangeError,
  withRetry,
} from "../../src/lib/retry.js";

describe("retry", () => {
  // ── calculateDelay (pure) ─────────────────────────────────────────────────

  describe("calculateDelay", () => {
    it("returns initialDelayMs for attempt 1 (no jitter)", () => {
      const delay = calculateDelay(1, 500, 5000, 2, 0);
      expect(delay).toBe(500);
    });

    it("applies backoff multiplier on subsequent attempts", () => {
      // attempt 2: 500 * 2^1 = 1000
      expect(calculateDelay(2, 500, 5000, 2, 0)).toBe(1000);
      // attempt 3: 500 * 2^2 = 2000
      expect(calculateDelay(3, 500, 5000, 2, 0)).toBe(2000);
    });

    it("caps at maxDelayMs", () => {
      // attempt 5: 500 * 2^4 = 8000, capped at 5000
      expect(calculateDelay(5, 500, 5000, 2, 0)).toBe(5000);
    });

    it("adds jitter within expected range", () => {
      const delays = Array.from({ length: 100 }, () =>
        calculateDelay(1, 1000, 10000, 2, 0.3),
      );
      // Base is 1000, jitter adds 0–30% → range [1000, 1300]
      expect(delays.every((d) => d >= 1000 && d <= 1300)).toBe(true);
    });

    it("handles attempt 1 with zero jitter exactly", () => {
      expect(calculateDelay(1, 200, 10000, 3, 0)).toBe(200);
    });
  });

  // ── withRetry ─────────────────────────────────────────────────────────────

  describe("withRetry", () => {
    it("returns success on first attempt when fn succeeds", async () => {
      const result = await withRetry(async () => 42, { maxAttempts: 3 });
      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
      expect(result.attempts).toBe(1);
      expect(result.lastError).toBeNull();
    });

    it("retries on failure and succeeds on subsequent attempt", async () => {
      let calls = 0;
      const result = await withRetry(
        async () => {
          calls++;
          if (calls < 3) throw new Error("transient");
          return "ok";
        },
        { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 5, jitterFraction: 0 },
      );

      expect(result.success).toBe(true);
      expect(result.value).toBe("ok");
      expect(result.attempts).toBe(3);
      expect(calls).toBe(3);
    });

    it("exhausts retries and returns failure", async () => {
      const result = await withRetry(
        async () => {
          throw new Error("always fails");
        },
        { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5, jitterFraction: 0 },
      );

      expect(result.success).toBe(false);
      expect(result.value).toBeNull();
      expect(result.attempts).toBe(3);
      expect(result.lastError).toBeInstanceOf(Error);
    });

    it("stops retrying when shouldRetry returns false", async () => {
      let calls = 0;
      const result = await withRetry(
        async () => {
          calls++;
          throw new Error("validation error");
        },
        {
          maxAttempts: 5,
          initialDelayMs: 1,
          shouldRetry: () => false,
        },
      );

      expect(result.success).toBe(false);
      expect(calls).toBe(1); // only 1 attempt, no retries
    });

    it("calls onRetry callback on each retry", async () => {
      const retries: number[] = [];
      let calls = 0;
      await withRetry(
        async () => {
          calls++;
          if (calls < 3) throw new Error("fail");
          return "done";
        },
        {
          maxAttempts: 5,
          initialDelayMs: 1,
          jitterFraction: 0,
          onRetry: (_err, attempt) => retries.push(attempt),
        },
      );

      expect(retries).toEqual([1, 2]);
    });

    it("handles maxAttempts = 1 (no retries)", async () => {
      const result = await withRetry(
        async () => {
          throw new Error("fail");
        },
        { maxAttempts: 1 },
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
    });
  });

  // ── Error Classification ──────────────────────────────────────────────────

  describe("is503", () => {
    it("detects 503 in Error message", () => {
      expect(is503(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    });

    it("detects maintenance keyword", () => {
      expect(is503(new Error("Exchange under maintenance"))).toBe(true);
    });

    it("detects service unavailable string", () => {
      expect(is503("503 service unavailable")).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(is503(new Error("Unknown asset: FAKE"))).toBe(false);
      expect(is503(new Error("timeout"))).toBe(false);
      expect(is503(42)).toBe(false);
    });
  });

  describe("is429", () => {
    it("detects 429 in Error message", () => {
      expect(is429(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    });

    it("detects rate limit keyword", () => {
      expect(is429(new Error("Rate limit exceeded"))).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(is429(new Error("500 Internal Server Error"))).toBe(false);
    });
  });

  describe("isRetryableExchangeError", () => {
    it("retries 503 errors", () => {
      expect(
        isRetryableExchangeError(new Error("503 Service Unavailable")),
      ).toBe(true);
    });

    it("retries 429 errors", () => {
      expect(isRetryableExchangeError(new Error("429 rate limit"))).toBe(true);
    });

    it("retries network errors", () => {
      expect(isRetryableExchangeError(new Error("ECONNRESET"))).toBe(true);
      expect(isRetryableExchangeError(new Error("fetch failed"))).toBe(true);
      expect(isRetryableExchangeError(new Error("timeout"))).toBe(true);
    });

    it("does NOT retry validation errors", () => {
      expect(isRetryableExchangeError(new Error("Unknown asset: FAKE"))).toBe(
        false,
      );
      expect(isRetryableExchangeError(new Error("minimum order value"))).toBe(
        false,
      );
      expect(isRetryableExchangeError(new Error("not initialized"))).toBe(
        false,
      );
    });

    it("retries unknown errors by default", () => {
      expect(isRetryableExchangeError(new Error("something weird"))).toBe(true);
    });
  });
});
