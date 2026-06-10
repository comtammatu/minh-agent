import { type CloseAllResult, closeAllPositions } from "../agent/close-all.js";
import { logOperatorAuditEntry } from "../agent/journal.js";
import { getAgent } from "../agent/trading-orchestrator.js";

export interface OperatorActionDeps {
  flatten: (reason: string) => Promise<CloseAllResult>;
  pause: (reason: string) => void;
  resume: () => void;
  logAudit: typeof logOperatorAuditEntry;
}

export interface OperatorFlattenResponse {
  ok: true;
  cancelled: number;
  closed: number;
  verifiedFlat: boolean;
  remainingPositions: number;
  remainingOrders: number;
}

export interface OperatorPauseResponse {
  ok: true;
  paused: true;
  reason: string;
}

export interface OperatorResumeResponse {
  ok: true;
  resumed: true;
}

export interface OperatorErrorResponse {
  error: string;
  code:
    | "missing_confirm"
    | "invalid_body"
    | "method_not_allowed"
    | "action_failed";
}

function defaultDeps(): OperatorActionDeps {
  const agent = getAgent();
  return {
    flatten: (reason) => closeAllPositions(reason),
    pause: (reason) => agent.pauseAll(reason),
    resume: () => agent.resumeAll(),
    logAudit: logOperatorAuditEntry,
  };
}

export function createOperatorActionDeps(
  overrides?: Partial<OperatorActionDeps>,
): OperatorActionDeps {
  return { ...defaultDeps(), ...overrides };
}

function hasConfirm(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { confirm?: unknown }).confirm === true
  );
}

function readReason(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const reason = (body as { reason?: unknown }).reason;
  if (typeof reason !== "string") return fallback;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : fallback;
}

export async function handleOperatorFlatten(
  body: unknown,
  deps: OperatorActionDeps = createOperatorActionDeps(),
): Promise<OperatorFlattenResponse | OperatorErrorResponse> {
  if (!hasConfirm(body)) {
    return { error: "confirm:true is required", code: "missing_confirm" };
  }
  const reason = readReason(body, "dashboard flatten");
  try {
    const result = await deps.flatten(reason);
    await deps.logAudit("flatten", "all", "submitted", {
      source: "dashboard",
      details: { reason, ...result },
    });
    return { ok: true, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.logAudit("flatten", "all", "failed", {
      source: "dashboard",
      details: { reason, error: message },
    });
    return { error: message, code: "action_failed" };
  }
}

export async function handleOperatorPause(
  body: unknown,
  deps: OperatorActionDeps = createOperatorActionDeps(),
): Promise<OperatorPauseResponse | OperatorErrorResponse> {
  if (!hasConfirm(body)) {
    return { error: "confirm:true is required", code: "missing_confirm" };
  }
  const reason = readReason(body, "dashboard pause");
  try {
    deps.pause(reason);
    await deps.logAudit("pause", "global", "submitted", {
      source: "dashboard",
      details: { reason },
    });
    return { ok: true, paused: true, reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.logAudit("pause", "global", "failed", {
      source: "dashboard",
      details: { reason, error: message },
    });
    return { error: message, code: "action_failed" };
  }
}

export async function handleOperatorResume(
  body: unknown,
  deps: OperatorActionDeps = createOperatorActionDeps(),
): Promise<OperatorResumeResponse | OperatorErrorResponse> {
  if (!hasConfirm(body)) {
    return { error: "confirm:true is required", code: "missing_confirm" };
  }
  const reason = readReason(body, "dashboard resume");
  try {
    deps.resume();
    await deps.logAudit("resume", "global", "submitted", {
      source: "dashboard",
      details: { reason },
    });
    return { ok: true, resumed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.logAudit("resume", "global", "failed", {
      source: "dashboard",
      details: { reason, error: message },
    });
    return { error: message, code: "action_failed" };
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-length") === "0") return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}
