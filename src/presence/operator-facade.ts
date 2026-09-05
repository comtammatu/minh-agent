import { closeAllPositions } from "../agent/close-all.js";
import { logOperatorAuditEntry } from "../agent/journal.js";
import { getOrderManager } from "../agent/order-manager.js";
import { getAgent } from "../agent/trading-orchestrator.js";
import type { OperatorIntent, OperatorPort } from "../ports/operator.js";

/** Shared operator facade for Voice (Presence). */
export function createOperatorPort(): OperatorPort {
  return {
    async execute(intent: OperatorIntent) {
      try {
        switch (intent.type) {
          case "pause": {
            getAgent().pauseAll(intent.reason);
            await logOperatorAuditEntry("pause", "runtime", "submitted", {
              source: "voice",
              details: { reason: intent.reason },
            });
            return { ok: true, detail: "paused" };
          }
          case "resume": {
            getAgent().resumeAll();
            await logOperatorAuditEntry("resume", "runtime", "submitted", {
              source: "voice",
            });
            return { ok: true, detail: "resumed" };
          }
          case "flatten": {
            await closeAllPositions(intent.reason);
            await logOperatorAuditEntry("flatten", "runtime", "submitted", {
              source: "voice",
              details: { reason: intent.reason },
            });
            return { ok: true, detail: "flattened" };
          }
          case "close": {
            await getOrderManager().handleAction({
              type: "close_position",
              positionId: intent.positionId,
              reason: intent.reason,
            });
            await logOperatorAuditEntry(
              "close",
              intent.positionId,
              "submitted",
              {
                source: "voice",
                details: { reason: intent.reason },
              },
            );
            return { ok: true, detail: "closed" };
          }
          case "reduce": {
            await getOrderManager().handleAction({
              type: "partial_close",
              positionId: intent.positionId,
              closePct: intent.pct,
            });
            await logOperatorAuditEntry(
              "reduce",
              intent.positionId,
              "submitted",
              {
                source: "voice",
                details: { pct: intent.pct, reason: intent.reason },
              },
            );
            return { ok: true, detail: `reduced ${intent.pct}%` };
          }
          default:
            return { ok: false, detail: "unknown intent" };
        }
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
