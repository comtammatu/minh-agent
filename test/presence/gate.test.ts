import { describe, expect, it, beforeEach } from "bun:test";
import {
  armCaseGateWithSetup,
  clearCaseGates,
  consumeCaseGate,
  getCaseGateMode,
  listPendingGates,
  shouldGateEntry,
} from "../../src/presence/gate.js";
import type { ActiveSetup } from "../../src/types.js";

const sampleSetup = (): ActiveSetup => ({
  id: "BTC|1h|minh|long",
  coin: "BTC",
  interval: "1h",
  type: "minh",
  side: "long",
  confidence: 0.9,
  entryPrice: 100,
  slPrice: 95,
  tpPrice: 110,
  patternData: {},
  confluenceGrade: "A+",
  detectedAt: Date.now(),
  detectedAtBar: 0,
  expiresAtBar: 100,
  exchange: "HL",
});

describe("Case Gate", () => {
  beforeEach(() => {
    clearCaseGates();
  });

  it("defaults to off", () => {
    expect(getCaseGateMode()).toBe("off");
    expect(
      shouldGateEntry({ grade: "A+", executionMode: "paper" }),
    ).toBe(false);
  });

  it("arms and lists pending gates", () => {
    armCaseGateWithSetup(
      {
        caseId: "BTC|1h|minh|long",
        setupId: "BTC|1h|minh|long",
        coin: "BTC",
        grade: "A+",
      },
      sampleSetup(),
    );
    expect(listPendingGates()).toHaveLength(1);
    expect(consumeCaseGate("BTC|1h|minh|long")).toBe("approved");
  });
});