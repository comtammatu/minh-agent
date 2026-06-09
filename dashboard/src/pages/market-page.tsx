import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboardData } from "@/app";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { formatPercent, formatTimestamp, formatUsd } from "@/lib/format";

interface DetailRowProps {
  label: string;
  value: string;
}

function DetailRow({ label, value }: DetailRowProps) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function MarketPage() {
  const snapshot = useDashboardData();
  const data = snapshot.data;
  const [searchParams, setSearchParams] = useSearchParams();

  const trackedCoins = data?.bootstrap.trackedCoins ?? [];
  const requestedCoin = searchParams.get("coin");
  const selectedCoin =
    requestedCoin && trackedCoins.includes(requestedCoin)
      ? requestedCoin
      : (trackedCoins[0] ?? "");

  useEffect(() => {
    if (!data) return;
    const nextParams = new URLSearchParams(searchParams);
    let changed = false;

    if (selectedCoin) {
      if (nextParams.get("coin") !== selectedCoin) {
        nextParams.set("coin", selectedCoin);
        changed = true;
      }
    } else if (nextParams.has("coin")) {
      nextParams.delete("coin");
      changed = true;
    }

    if (nextParams.has("resolution")) {
      nextParams.delete("resolution");
      changed = true;
    }

    if (changed) {
      setSearchParams(nextParams, { replace: true });
    }
  }, [data, searchParams, selectedCoin, setSearchParams]);

  const watchlistRow = useMemo(
    () => data?.watchlist.find((row) => row.coin === selectedCoin) ?? null,
    [data, selectedCoin],
  );
  const activeSetup = useMemo(
    () =>
      data?.activeSetups.find((setup) => setup.coin === selectedCoin) ?? null,
    [data, selectedCoin],
  );
  const position = useMemo(
    () => data?.positions.find((item) => item.coin === selectedCoin) ?? null,
    [data, selectedCoin],
  );

  if (!data) {
    return (
      <Alert>
        <AlertTitle>Market view waiting for snapshot</AlertTitle>
        <AlertDescription>
          {snapshot.error ?? "Snapshot has not arrived yet."}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Market</h1>
          <p className="text-sm text-muted-foreground">
            Selected market state, active setup context, and open position
            detail from the runtime snapshot.
          </p>
        </div>
        <div className="grid gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Ticker
          </span>
          <Select
            value={selectedCoin}
            onValueChange={(value) => {
              const nextParams = new URLSearchParams(searchParams);
              nextParams.set("coin", value);
              nextParams.delete("resolution");
              setSearchParams(nextParams, { replace: true });
            }}
          >
            <SelectTrigger className="min-w-44" aria-label="Select market">
              <SelectValue placeholder="Select coin" />
            </SelectTrigger>
            <SelectContent>
              {data.bootstrap.trackedCoins.map((coin) => (
                <SelectItem key={coin} value={coin}>
                  {coin}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <CardDescription>Runtime market state</CardDescription>
            <CardTitle>{selectedCoin || "No coin selected"}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {watchlistRow ? (
              <>
                <DetailRow
                  label="Mark"
                  value={formatUsd(watchlistRow.markPrice)}
                />
                <DetailRow
                  label="Bias"
                  value={`${watchlistRow.bias} / ${watchlistRow.regime}`}
                />
                <DetailRow
                  label="Bias confidence"
                  value={formatPercent(watchlistRow.biasConfidence)}
                />
                <DetailRow
                  label="Funding"
                  value={formatPercent(watchlistRow.funding)}
                />
                <DetailRow
                  label="Day change"
                  value={formatPercent(watchlistRow.dayChangePctUtc)}
                />
                <DetailRow
                  label="Active setups"
                  value={String(watchlistRow.activeCount)}
                />
              </>
            ) : (
              <Alert className="md:col-span-2 xl:col-span-3">
                <AlertTitle>No watchlist row</AlertTitle>
                <AlertDescription>
                  This coin has not reported runtime market status yet.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardDescription>Setup focus</CardDescription>
              <CardTitle>{selectedCoin || "No coin selected"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {activeSetup ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant={
                        activeSetup.side === "long" ? "default" : "destructive"
                      }
                    >
                      {activeSetup.side}
                    </Badge>
                    <Badge variant="outline">{activeSetup.interval}</Badge>
                  </div>
                  <DetailRow
                    label="Entry"
                    value={formatUsd(activeSetup.entryPrice)}
                  />
                  <DetailRow
                    label="Stop loss"
                    value={formatUsd(activeSetup.slPrice)}
                  />
                  <DetailRow
                    label="Take profit"
                    value={formatUsd(activeSetup.tpPrice)}
                  />
                  <DetailRow
                    label="Confidence"
                    value={formatPercent(activeSetup.confidence)}
                  />
                  <DetailRow
                    label="Detected"
                    value={formatTimestamp(activeSetup.detectedAt)}
                  />
                </>
              ) : (
                <Alert>
                  <AlertTitle>No active setup</AlertTitle>
                  <AlertDescription>
                    No setup is currently being tracked for this coin.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardDescription>Position focus</CardDescription>
              <CardTitle>Open exposure</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {position ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant={
                        position.side === "long" ? "default" : "destructive"
                      }
                    >
                      {position.side}
                    </Badge>
                    <Badge variant="outline">{position.leverage}x</Badge>
                  </div>
                  <Separator />
                  <DetailRow
                    label="Entry"
                    value={formatUsd(position.entryPrice)}
                  />
                  <DetailRow
                    label="Mark"
                    value={formatUsd(position.markPrice)}
                  />
                  <DetailRow
                    label="uPnL"
                    value={formatUsd(position.unrealizedPnl)}
                  />
                  <DetailRow
                    label="Size"
                    value={String(position.currentSize)}
                  />
                </>
              ) : (
                <Alert>
                  <AlertTitle>No open position</AlertTitle>
                  <AlertDescription>
                    This coin is not currently in position.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
