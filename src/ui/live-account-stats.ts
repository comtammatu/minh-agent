/**
 * Live Account TUI helpers — closed-trade stats for the canonical runtime wallet.
 * Pure functions + types shared with tui.tsx (no I/O here).
 */

/** Closed-trade aggregates for the shared runtime wallet (from DB). */
export interface WalletClosedTradeStatsRow {
  walletLabel: string;
  wins: number;
  losses: number;
  tradeCount: number;
}

export interface LiveWalletRow {
  label: string;
  wins: number;
  losses: number;
  tradeCount: number;
  winRate: number;
}

export interface LiveWalletStats {
  wallets: LiveWalletRow[];
  wins: number;
  losses: number;
  tradeCount: number;
  winRate: number;
}

export function normalizeWalletLabel(raw: string | undefined): string {
  return raw ?? "smc-sd";
}

/** Build TUI stats from DB rows; emits one canonical wallet row. */
export function buildLiveWalletStats(
  rows: WalletClosedTradeStatsRow[],
): LiveWalletStats {
  const r = rows[0];
  const tc = r?.tradeCount ?? 0;
  const w = r?.wins ?? 0;
  const wallets: LiveWalletRow[] = [
    {
      label: normalizeWalletLabel(r?.walletLabel),
      wins: w,
      losses: r?.losses ?? 0,
      tradeCount: tc,
      winRate: tc > 0 ? w / tc : 0,
    },
  ];
  const wins = wallets.reduce((s, w) => s + w.wins, 0);
  const losses = wallets.reduce((s, w) => s + w.losses, 0);
  const tradeCount = wallets.reduce((s, w) => s + w.tradeCount, 0);
  return {
    wallets,
    wins,
    losses,
    tradeCount,
    winRate: tradeCount > 0 ? wins / tradeCount : 0,
  };
}
