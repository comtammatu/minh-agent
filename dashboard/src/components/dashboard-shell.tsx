import { Activity, CandlestickChart, Menu, ScrollText } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useDashboardData } from '@/app'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/', label: 'Overview', icon: Activity },
  { to: '/market', label: 'Market', icon: CandlestickChart },
  { to: '/journal', label: 'Journal', icon: ScrollText },
] as const

function NavRail({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav className={cn('grid gap-1', mobile && 'pt-4')}>
      {NAV_ITEMS.map(item => {
        const Icon = item.icon
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(buttonVariants({ variant: isActive ? 'secondary' : 'ghost' }), 'w-full justify-start')
            }
          >
            <Icon className="h-4 w-4" />
            <span>{item.label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}

export function DashboardShell() {
  const snapshot = useDashboardData()
  const data = snapshot.data
  const isReady = data?.bootstrap.phase === 'ready'

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[240px_1fr]">
        <aside className="hidden border-r bg-muted/20 lg:flex lg:flex-col">
          <div className="flex h-full flex-col p-6">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">Minh Dashboard</h1>
              <p className="text-sm text-muted-foreground">
                Read-only runtime view for operations, market context, and journal review.
              </p>
            </div>
            <Separator className="my-6" />
            <NavRail />
            <Card className="mt-auto">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Runtime state</CardTitle>
                <CardDescription>Current bootstrap phase and execution mode.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Badge variant={isReady ? 'default' : 'secondary'}>{data?.bootstrap.phase ?? 'warming_up'}</Badge>
                <Badge variant="outline">{data?.mode.exchange ?? '—'}</Badge>
                <Badge variant="destructive">live</Badge>
              </CardContent>
            </Card>
          </div>
        </aside>

        <div className="flex min-h-screen flex-col">
          <header className="border-b">
            <div className="flex items-center justify-between gap-4 px-4 py-4 md:px-6">
              <div className="flex items-start gap-3">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="icon" className="lg:hidden">
                      <Menu className="h-4 w-4" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left">
                    <SheetHeader>
                      <SheetTitle>Minh Dashboard</SheetTitle>
                      <SheetDescription>Overview, market canvas, and journal pages.</SheetDescription>
                    </SheetHeader>
                    <NavRail mobile />
                  </SheetContent>
                </Sheet>
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold">Read-only ops console</h2>
                  <p className="text-sm text-muted-foreground">
                    Live snapshot of the current runtime with market and journal drilldown.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge variant={isReady ? 'default' : 'secondary'}>
                  {isReady ? 'ready' : 'warming up'}
                </Badge>
                <Badge variant="outline">{data?.mode.exchange ?? '—'}</Badge>
                <Badge variant="destructive">live</Badge>
              </div>
            </div>
          </header>

          <ScrollArea className="flex-1">
            <main className="space-y-4 p-4 md:p-6">
              {snapshot.error && data ? (
                <Alert variant="destructive">
                  <AlertTitle>Snapshot refresh degraded</AlertTitle>
                  <AlertDescription>{snapshot.error}</AlertDescription>
                </Alert>
              ) : null}
              <Outlet />
            </main>
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}
