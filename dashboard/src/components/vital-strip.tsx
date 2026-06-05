import { Badge } from "@/components/ui/badge";
import { formatChangePercent, formatUsd } from "@/lib/format";
import type { DashboardSnapshotResponse } from "@/lib/dashboard-types";
import { cn } from "@/lib/utils";

interface VitalStripProps {
  data: DashboardSnapshotResponse;
  snapshotError: string | null;
}

interface VitalSlotProps {
  label: string;
  value: string;
  valueClassName?: string;
}

function VitalSlot({ label, value, valueClassName }: VitalSlotProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-1">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "truncate font-mono text-sm font-semibold tabular-nums",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

function modeBadgeVariant(
  paperTrade: boolean,
): "default" | "secondary" | "destructive" | "outline" {
  return paperTrade ? "secondary" : "destructive";
}

export function VitalStrip({ data, snapshotError }: VitalStripProps) {
  const dailyPnl = data.summaryMetrics.pnl.daily;
  const equity = data.account.equity;
  const pnlClass =
    dailyPnl > 0
      ? "text-emerald-400"
      : dailyPnl < 0
        ? "text-red-400"
        : "text-foreground";

  return (
    <div className="flex flex-wrap items-stretch divide-x divide-border/60 border-b border-border/60 bg-card/70 backdrop-blur">
      <div className="flex items-center gap-2 px-3 py-1">
        <Badge variant={modeBadgeVariant(data.mode.paperTrade)}>
          {data.mode.paperTrade ? "PAPER" : "LIVE"}
        </Badge>
        <Badge variant="outline">{data.mode.exchange}</Badge>
      </div>
      <VitalSlot label="Equity" value={formatUsd(equity)} />
      <VitalSlot
        label="Day PnL"
        value={formatUsd(dailyPnl)}
        valueClassName={pnlClass}
      />
      <VitalSlot
        label="Open Pos"
        value={String(data.summaryMetrics.openPositionCount)}
      />
      <VitalSlot
        label="Setups"
        value={String(data.activeSetups.length)}
      />
      <VitalSlot
        label="Circuit"
        value={
          data.operator.globalPaused
            ? data.operator.pauseReason ?? "PAUSED"
            : "CB OK"
        }
        valueClassName={
          data.operator.globalPaused ? "text-red-400" : "text-emerald-400"
        }
      />
      <VitalSlot
        label="Feed"
        value={
          snapshotError
            ? "POLL DEGRADED"
            : data.health.components.feed.status === "ok"
              ? "POLL OK"
              : data.health.components.feed.status.toUpperCase()
        }
        valueClassName={
          snapshotError || data.health.components.feed.status !== "ok"
            ? "text-amber-400"
            : "text-emerald-400"
        }
      />
      <VitalSlot
        label="Day %"
        value={formatChangePercent(
          equity && equity !== 0 ? (dailyPnl / equity) * 100 : null,
        )}
        valueClassName={pnlClass}
      />
    </div>
  );
}
