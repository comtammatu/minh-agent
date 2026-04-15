import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useDashboardData } from '@/app'
import { formatDuration, formatPercent, formatTimestamp, formatUsd } from '@/lib/format'

interface MetricCardProps {
  label: string
  value: string
  hint: string
}

function formatDetailsPreview(details: unknown): string {
  if (details === null || details === undefined) return 'No details provided.'
  if (typeof details === 'string') return details
  try {
    return JSON.stringify(details, null, 2)
  } catch {
    return String(details)
  }
}

function MetricCard({ label, value, hint }: MetricCardProps) {
  return (
    <Card>
      <CardHeader className="space-y-1 pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{hint}</CardContent>
    </Card>
  )
}

export function OverviewPage() {
  const snapshot = useDashboardData()
  const data = snapshot.data

  if (snapshot.isLoading && !data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    )
  }

  if (snapshot.error && !data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Snapshot unavailable</AlertTitle>
        <AlertDescription>{snapshot.error}</AlertDescription>
      </Alert>
    )
  }

  if (!data) return null

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Account snapshot, live exposure, runtime health, watchlist context, and recent journal activity.
        </p>
      </div>

      {data.bootstrap.phase !== 'ready' ? (
        <Alert>
          <AlertTitle>Runtime is still warming up</AlertTitle>
          <AlertDescription>
            The dashboard is live, but backfill has not finished yet. Watchlist and setups will stabilize once bootstrap completes.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Account equity"
          value={formatUsd(data.account.equity)}
          hint={`Balance ${formatUsd(data.account.balance)}`}
        />
        <MetricCard
          label="Daily PnL"
          value={formatUsd(data.summaryMetrics.pnl.daily)}
          hint={`Win rate ${formatPercent(data.summaryMetrics.winRate.daily)}`}
        />
        <MetricCard
          label="Open positions"
          value={String(data.summaryMetrics.openPositionCount)}
          hint={`Unrealized ${formatUsd(data.account.unrealizedPnl)}`}
        />
        <MetricCard
          label="System uptime"
          value={formatDuration(data.health.uptime)}
          hint={`RSS ${Math.round(data.health.rssBytes / 1_000_000)} MB`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardDescription>Open positions</CardDescription>
            <CardTitle>Live exposure</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Coin</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>Mark</TableHead>
                  <TableHead>uPnL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.positions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No open positions
                    </TableCell>
                  </TableRow>
                ) : data.positions.map(position => (
                  <TableRow key={position.positionId}>
                    <TableCell className="font-medium">{position.coin}</TableCell>
                    <TableCell>
                      <Badge variant={position.side === 'long' ? 'default' : 'destructive'}>{position.side}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">{formatUsd(position.entryPrice)}</TableCell>
                    <TableCell className="tabular-nums">{formatUsd(position.markPrice)}</TableCell>
                    <TableCell className="tabular-nums">{formatUsd(position.unrealizedPnl)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Runtime health</CardDescription>
            <CardTitle>Health checks</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(data.health.components).map(([key, component]) => (
              <div key={key} className="flex items-center justify-between rounded-lg border bg-muted/50 px-4 py-3">
                <div>
                  <p className="text-sm font-medium capitalize">{key}</p>
                  <p className="text-xs text-muted-foreground">Errors {component.consecutiveErrors}</p>
                </div>
                <Badge variant={component.status === 'ok' ? 'default' : 'secondary'}>{component.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Watchlist</CardDescription>
            <CardTitle>Bias + regime matrix</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Coin</TableHead>
                  <TableHead>TF</TableHead>
                  <TableHead>Bias</TableHead>
                  <TableHead>Regime</TableHead>
                  <TableHead>Price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.watchlist.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No watchlist rows yet
                    </TableCell>
                  </TableRow>
                ) : data.watchlist.slice(0, 10).map(row => (
                  <TableRow key={`${row.coin}-${row.interval}`}>
                    <TableCell>{row.coin}</TableCell>
                    <TableCell>{row.interval}</TableCell>
                    <TableCell>{row.bias}</TableCell>
                    <TableCell>{row.regime}</TableCell>
                    <TableCell className="tabular-nums">{formatUsd(row.markPrice)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Recent journal</CardDescription>
            <CardTitle>Decision trail</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[320px]">
              <div className="space-y-3">
                {data.recentJournal.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No recent journal entries.</div>
                ) : data.recentJournal.map(entry => (
                  <div key={entry.id} className="rounded-lg border bg-muted/50 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{entry.eventType}</Badge>
                        {entry.coin ? <span className="text-sm font-medium">{entry.coin}</span> : null}
                      </div>
                      <span className="text-xs text-muted-foreground">{formatTimestamp(entry.ts)}</span>
                    </div>
                    <pre className="mt-2 overflow-x-auto rounded-md border border-border/60 bg-background/60 px-3 py-2 text-xs leading-6 text-muted-foreground">
                      {formatDetailsPreview(entry.details)}
                    </pre>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
