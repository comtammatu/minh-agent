/**
 * Case Gate — optional human confirm for high-grade entries (paper first).
 * CASE_GATE_MODE=off|paper|live
 */

import type { ActiveSetup } from "../types.js";

export type CaseGateMode = "off" | "paper" | "live";

export function getCaseGateMode(): CaseGateMode {
  const raw = (process.env.CASE_GATE_MODE ?? "off").toLowerCase();
  if (raw === "paper" || raw === "live") return raw;
  return "off";
}

export const CASE_GATE_CONFIRM_TTL_MS = 30_000;

export interface PendingGate {
  caseId: string;
  setupId: string;
  coin: string;
  grade?: string | undefined;
  expiresAt: number;
}

const pending = new Map<string, PendingGate>();
const deferredSetups = new Map<string, ActiveSetup>();

export function listPendingGates(): PendingGate[] {
  const now = Date.now();
  return [...pending.values()].filter((p) => p.expiresAt > now);
}

export function shouldGateEntry(opts: {
  grade?: string | undefined;
  executionMode: "paper" | "live";
}): boolean {
  const mode = getCaseGateMode();
  if (mode === "off") return false;
  if (mode === "paper" && opts.executionMode !== "paper") return false;
  if (mode === "live" && opts.executionMode !== "live") return false;
  const g = opts.grade?.toUpperCase();
  return g === "A" || g === "A+";
}

export function armCaseGate(p: Omit<PendingGate, "expiresAt">): PendingGate {
  const entry: PendingGate = {
    ...p,
    expiresAt: Date.now() + CASE_GATE_CONFIRM_TTL_MS,
  };
  pending.set(p.caseId, entry);
  return entry;
}

export function armCaseGateWithSetup(
  p: Omit<PendingGate, "expiresAt">,
  setup: ActiveSetup,
): PendingGate {
  deferredSetups.set(p.caseId, setup);
  return armCaseGate(p);
}

export function takeDeferredSetup(caseId: string): ActiveSetup | undefined {
  const setup = deferredSetups.get(caseId);
  deferredSetups.delete(caseId);
  return setup;
}

export function consumeCaseGate(
  caseId: string,
): "approved" | "expired" | "missing" {
  const p = pending.get(caseId);
  if (!p) return "missing";
  pending.delete(caseId);
  if (Date.now() > p.expiresAt) return "expired";
  return "approved";
}

export function getPendingGate(caseId: string): PendingGate | undefined {
  return pending.get(caseId);
}

export function clearCaseGates(): void {
  pending.clear();
  deferredSetups.clear();
}
