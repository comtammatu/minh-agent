import type { DecisionTrace } from "../../types.js";

export type CaseGateStatus =
  | "none"
  | "pending"
  | "approved"
  | "expired"
  | "skipped";

/** Normalized Case card for Body + Voice. */
export interface CaseCard {
  id: string;
  coin: string;
  interval: string;
  ts: number;
  action: string;
  confidence: number;
  summary: string;
  positionId: string | null;
  setupId: string | null;
  guardian?: { state: string; summary: string };
  executor?: { state: string; summary: string };
  judge?: { verdict?: string };
  timeline: Array<{ actor: string; summary: string }>;
  gate: CaseGateStatus;
}

const cases = new Map<string, CaseCard>();

function caseId(trace: DecisionTrace): string {
  return (
    trace.outcome.positionId ??
    trace.outcome.setupId ??
    `${trace.coin}:${trace.interval}:${trace.ts}`
  );
}

export function upsertCaseFromTrace(
  trace: DecisionTrace,
  gate: CaseGateStatus = "none",
): CaseCard {
  const card: CaseCard = {
    id: caseId(trace),
    coin: trace.coin,
    interval: trace.interval,
    ts: trace.ts,
    action: trace.outcome.action,
    confidence: trace.outcome.confidence,
    summary: trace.outcome.summary,
    positionId: trace.outcome.positionId,
    setupId: trace.outcome.setupId,
    timeline: trace.timeline.map((t) => ({
      actor: t.actor,
      summary: t.summary,
    })),
    gate,
  };
  if (trace.roles.guardian) {
    card.guardian = {
      state: trace.roles.guardian.state,
      summary: trace.roles.guardian.summary,
    };
  }
  if (trace.roles.executor) {
    card.executor = {
      state: trace.roles.executor.state,
      summary: trace.roles.executor.summary,
    };
  }
  if (trace.roles.judge) {
    card.judge = trace.roles.judge;
  }
  cases.set(card.id, card);
  return card;
}

export function getCase(id: string): CaseCard | undefined {
  return cases.get(id);
}

export function listCases(limit = 20): CaseCard[] {
  return [...cases.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export function setCaseGate(id: string, gate: CaseGateStatus): void {
  const c = cases.get(id);
  if (!c) return;
  cases.set(id, { ...c, gate });
}

export function clearCases(): void {
  cases.clear();
}
