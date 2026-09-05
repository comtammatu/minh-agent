/** Crash safety — same meaning on HL and BB, different mechanisms. */
export interface CrashGuardPort {
  arm(): Promise<void>;
  refresh(): Promise<void>;
  disarm(): Promise<void>;
  /** Presence field */
  status(): "armed" | "disarmed" | "degraded";
}
