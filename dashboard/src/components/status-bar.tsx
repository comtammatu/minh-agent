import type { DashboardSnapshotResponse } from "@/lib/dashboard-types";
import { formatDuration } from "@/lib/format";

interface StatusBarProps {
  data: DashboardSnapshotResponse;
  snapshotError: string | null;
}

function formatUtcClock(now = new Date()): string {
  return now.toISOString().replace("T", " ").slice(0, 19);
}

export function StatusBar({ data, snapshotError }: StatusBarProps) {
  const feed = data.health.components.feed;
  const db = data.health.components.db;
  const exchange = data.health.components.exchange;

  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 bg-background/90 px-4 py-1.5 text-[11px] text-muted-foreground">
      <span>
        Poll · {data.mode.exchange} · {snapshotError ? "degraded" : feed.status}
      </span>
      <span>Uptime · {formatDuration(data.health.uptime)}</span>
      <span>Agent · {data.operator.globalPaused ? "paused" : "active"}</span>
      <span>
        Health · feed {feed.consecutiveErrors} / db {db.consecutiveErrors} / ex{" "}
        {exchange.consecutiveErrors}
      </span>
      <span>RSS · {Math.round(data.health.rssBytes / 1_000_000)} MB</span>
      <span className="ml-auto font-mono tabular-nums">
        {formatUtcClock()} UTC
      </span>
    </footer>
  );
}
