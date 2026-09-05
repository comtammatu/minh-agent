/** Read models for Presence Voice / Body — no money-path side effects. */
export interface QueryPort {
  getStatusSummary(): Promise<string> | string;
  getPositionsText(): Promise<string> | string;
  getPnlText(): Promise<string> | string;
  getAdvisorText(): Promise<string> | string;
}

export type OperatorIntent =
  | { type: "pause"; reason: string; coin?: string; durationMs?: number }
  | { type: "resume" }
  | { type: "flatten"; reason: string; confirm: true }
  | {
      type: "close";
      positionId: string;
      reason: string;
      confirm: true;
    }
  | {
      type: "reduce";
      positionId: string;
      pct: 25 | 50;
      reason: string;
      confirm: true;
    };

export interface OperatorPort {
  execute(intent: OperatorIntent): Promise<{ ok: boolean; detail?: string }>;
}
