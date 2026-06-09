import { describe, expect, it } from "bun:test";
import {
  createOperatorActionDeps,
  handleOperatorFlatten,
  handleOperatorPause,
  handleOperatorResume,
} from "./operator-actions.js";

describe("operator-actions", () => {
  it("flatten rejects missing confirm", async () => {
    const result = await handleOperatorFlatten(
      {},
      createOperatorActionDeps({
        flatten: async () => ({ cancelled: 0, closed: 0 }),
        pause: () => {},
        resume: () => {},
        logAudit: async () => {},
      }),
    );
    expect(result).toEqual({
      error: "confirm:true is required",
      code: "missing_confirm",
    });
  });

  it("flatten executes close-all and logs audit", async () => {
    const audits: Array<{ action: string; status: string }> = [];
    const result = await handleOperatorFlatten(
      { confirm: true, reason: "panic" },
      createOperatorActionDeps({
        flatten: async () => ({ cancelled: 2, closed: 1 }),
        pause: () => {},
        resume: () => {},
        logAudit: async (action, _target, status) => {
          audits.push({ action, status });
        },
      }),
    );
    expect(result).toEqual({ ok: true, cancelled: 2, closed: 1 });
    expect(audits).toEqual([{ action: "flatten", status: "submitted" }]);
  });

  it("pause requires confirm and logs audit", async () => {
    let pausedReason = "";
    const result = await handleOperatorPause(
      { confirm: true, reason: "manual halt" },
      createOperatorActionDeps({
        flatten: async () => ({ cancelled: 0, closed: 0 }),
        pause: (reason) => {
          pausedReason = reason;
        },
        resume: () => {},
        logAudit: async () => {},
      }),
    );
    expect(result).toEqual({
      ok: true,
      paused: true,
      reason: "manual halt",
    });
    expect(pausedReason).toBe("manual halt");
  });

  it("resume rejects missing confirm", async () => {
    const result = await handleOperatorResume(
      {},
      createOperatorActionDeps({
        flatten: async () => ({ cancelled: 0, closed: 0 }),
        pause: () => {},
        resume: () => {},
        logAudit: async () => {},
      }),
    );
    expect(result).toEqual({
      error: "confirm:true is required",
      code: "missing_confirm",
    });
  });

  it("resume executes with confirm", async () => {
    let resumed = false;
    const result = await handleOperatorResume(
      { confirm: true },
      createOperatorActionDeps({
        flatten: async () => ({ cancelled: 0, closed: 0 }),
        pause: () => {},
        resume: () => {
          resumed = true;
        },
        logAudit: async () => {},
      }),
    );
    expect(result).toEqual({ ok: true, resumed: true });
    expect(resumed).toBe(true);
  });

  it("flatten logs failed audit on error", async () => {
    const audits: string[] = [];
    const result = await handleOperatorFlatten(
      { confirm: true },
      createOperatorActionDeps({
        flatten: async () => {
          throw new Error("exchange down");
        },
        pause: () => {},
        resume: () => {},
        logAudit: async (_action, _target, status) => {
          audits.push(status);
        },
      }),
    );
    expect(result.code).toBe("action_failed");
    expect(audits).toEqual(["failed"]);
  });
});
