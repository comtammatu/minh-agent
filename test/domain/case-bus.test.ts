import { describe, expect, it } from "bun:test";
import {
  clearCases,
  listCases,
  upsertCaseFromTrace,
} from "../../src/domain/case/bus.js";
import type { DecisionTrace } from "../../src/types.js";

describe("Case bus", () => {
  it("upserts a CaseCard from DecisionTrace", () => {
    clearCases();
    const trace: DecisionTrace = {
      coin: "BTC",
      interval: "1h",
      ts: 1,
      outcome: {
        action: "ENTER",
        confidence: 0.8,
        summary: "test",
        positionId: "p1",
        setupId: "s1",
      },
      roles: {},
      timeline: [{ actor: "scanner", summary: "found" }],
    };
    const card = upsertCaseFromTrace(trace);
    expect(card.id).toBe("p1");
    expect(listCases()[0]?.coin).toBe("BTC");
  });
});
