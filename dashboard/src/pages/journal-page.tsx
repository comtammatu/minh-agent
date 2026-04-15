import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useDashboardData } from '@/app'
import { useJournalRows } from '@/lib/api'
import type { DashboardEventType, DashboardJournalRow } from '@/lib/dashboard-types'
import { formatTimestamp } from '@/lib/format'

const EVENT_OPTIONS: Array<DashboardEventType | 'ALL'> = [
  'ALL',
  'signal',
  'enter',
  'exit',
  'invalidate',
  'skip',
  'pause',
  'resume',
  'operator',
]

export function JournalPage() {
  const snapshot = useDashboardData()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selected, setSelected] = useState<DashboardJournalRow | null>(null)
  const searchKey = searchParams.toString()
  const trackedCoins = snapshot.data?.bootstrap.trackedCoins ?? null

  const coins = useMemo(() => ['ALL', ...(trackedCoins ?? [])], [trackedCoins])
  const requestedCoin = searchParams.get('coin') ?? 'ALL'
  const coin =
    trackedCoins === null
      ? (requestedCoin as string | 'ALL')
      : coins.includes(requestedCoin)
        ? (requestedCoin as string | 'ALL')
        : 'ALL'
  const requestedEvent = searchParams.get('event') ?? 'ALL'
  const eventType = EVENT_OPTIONS.includes(requestedEvent as DashboardEventType | 'ALL')
    ? (requestedEvent as DashboardEventType | 'ALL')
    : 'ALL'
  const journal = useJournalRows(snapshot.data ? coin : null, eventType, 200)

  useEffect(() => {
    if (!snapshot.data) return
    const nextParams = new URLSearchParams(searchParams)
    let changed = false

    if (coin === 'ALL') {
      if (nextParams.has('coin')) {
        nextParams.delete('coin')
        changed = true
      }
    } else if (nextParams.get('coin') !== coin) {
      nextParams.set('coin', coin)
      changed = true
    }

    if (eventType === 'ALL') {
      if (nextParams.has('event')) {
        nextParams.delete('event')
        changed = true
      }
    } else if (nextParams.get('event') !== eventType) {
      nextParams.set('event', eventType)
      changed = true
    }

    if (changed) {
      setSearchParams(nextParams, { replace: true })
    }
  }, [coin, eventType, searchKey, searchParams, setSearchParams, snapshot.data])

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Journal</h1>
        <p className="text-sm text-muted-foreground">
          Filter the live event ledger and inspect full event details without leaving the dashboard.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>Trade journal</CardDescription>
          <CardTitle>Event ledger</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:max-w-xl">
          <div className="grid gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Coin</span>
            <Select
              value={coin}
              onValueChange={value => {
                const nextParams = new URLSearchParams(searchParams)
                if (value === 'ALL') nextParams.delete('coin')
                else nextParams.set('coin', value)
                if (eventType === 'ALL') nextParams.delete('event')
                else nextParams.set('event', eventType)
                setSearchParams(nextParams, { replace: true })
              }}
            >
              <SelectTrigger className="min-w-44" aria-label="Filter journal by coin">
                <SelectValue placeholder="Coin filter" />
              </SelectTrigger>
              <SelectContent>
                {coins.map(option => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Event</span>
            <Select
              value={eventType}
              onValueChange={value => {
                const nextParams = new URLSearchParams(searchParams)
                if (coin === 'ALL') nextParams.delete('coin')
                else nextParams.set('coin', coin)
                if (value === 'ALL') nextParams.delete('event')
                else nextParams.set('event', value)
                setSearchParams(nextParams, { replace: true })
              }}
            >
              <SelectTrigger className="min-w-44" aria-label="Filter journal by event type">
                <SelectValue placeholder="Event filter" />
              </SelectTrigger>
              <SelectContent>
                {EVENT_OPTIONS.map(option => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {journal.error ? (
        <Alert variant="destructive">
          <AlertTitle>Journal request failed</AlertTitle>
          <AlertDescription>{journal.error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <ScrollArea className="h-[640px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Coin</TableHead>
                  <TableHead>Exchange</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="w-[96px] text-right">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {journal.data && journal.data.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No journal rows matched the current filters
                    </TableCell>
                  </TableRow>
                ) : (journal.data?.rows ?? []).map(row => (
                  <TableRow key={row.id} className="hover:bg-muted/35">
                    <TableCell>{formatTimestamp(row.ts)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{row.eventType}</Badge>
                    </TableCell>
                    <TableCell>{row.coin ?? '—'}</TableCell>
                    <TableCell>{row.exchange}</TableCell>
                    <TableCell>{row.agentState ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelected(row)}
                        aria-label={`Open journal details for ${row.eventType}${row.coin ? ` ${row.coin}` : ''}`}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>

      <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{selected?.eventType ?? 'Journal detail'}</SheetTitle>
            <SheetDescription>{selected ? formatTimestamp(selected.ts) : '—'}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-auto">
            <pre className="rounded-md border bg-muted p-4 text-xs leading-6 text-muted-foreground">
              {selected ? JSON.stringify(selected.details, null, 2) : ''}
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
