import { Activity, CandlestickChart, Menu, ScrollText } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useDashboardData } from "@/app";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { StatusBar } from "@/components/status-bar";
import { VitalStrip } from "@/components/vital-strip";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "Overview", icon: Activity },
  { to: "/market", label: "Market", icon: CandlestickChart },
  { to: "/journal", label: "Journal", icon: ScrollText },
] as const;

const TERMINAL_TITLE = "Minh Algo Trading Terminal";

function NavRail({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav className={cn("grid gap-1", mobile && "pt-4")}>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                buttonVariants({ variant: isActive ? "secondary" : "ghost" }),
                "w-full justify-start",
              )
            }
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

function RuntimeBadge({
  paperTrade,
  exchange,
}: {
  paperTrade: boolean;
  exchange: string;
}) {
  return (
    <>
      <Badge variant={paperTrade ? "secondary" : "destructive"}>
        {paperTrade ? "paper" : "live"}
      </Badge>
      <Badge variant="outline">{exchange}</Badge>
    </>
  );
}

export function DashboardShell() {
  const snapshot = useDashboardData();
  const data = snapshot.data;
  const isReady = data?.bootstrap.phase === "ready";

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.06),_transparent_28%),linear-gradient(180deg,_#18181b_0%,_#101113_100%)] text-foreground">
      <a
        href="#dashboard-main"
        className="sr-only absolute left-4 top-4 z-50 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm focus:not-sr-only focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to main content
      </a>
      <div className="grid min-h-screen lg:grid-cols-[240px_1fr]">
        <aside className="hidden border-r border-white/5 bg-card/60 lg:flex lg:flex-col lg:backdrop-blur">
          <div className="flex h-full flex-col p-6">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">{TERMINAL_TITLE}</h1>
              <p className="text-sm text-muted-foreground">
                Bloomberg-density operator console for runtime inspection,
                market context, and journal review.
              </p>
            </div>
            <Separator className="my-6" />
            <NavRail />
            <Card className="mt-auto">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Runtime state</CardTitle>
                <CardDescription>
                  Bootstrap phase, exchange, and execution mode.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Badge variant={isReady ? "default" : "secondary"}>
                  {data?.bootstrap.phase ?? "warming_up"}
                </Badge>
                {data ? (
                  <RuntimeBadge
                    paperTrade={data.mode.paperTrade}
                    exchange={data.mode.exchange}
                  />
                ) : null}
              </CardContent>
            </Card>
          </div>
        </aside>

        <div className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
            <div className="flex items-center justify-between gap-4 px-4 py-3 md:px-6">
              <div className="flex items-start gap-3">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="lg:hidden"
                      aria-label="Open navigation menu"
                    >
                      <Menu className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left">
                    <SheetHeader>
                      <SheetTitle>{TERMINAL_TITLE}</SheetTitle>
                      <SheetDescription>
                        Overview, market canvas, and journal pages.
                      </SheetDescription>
                    </SheetHeader>
                    <NavRail mobile />
                  </SheetContent>
                </Sheet>
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold">{TERMINAL_TITLE}</h2>
                  <p className="text-sm text-muted-foreground">
                    Read-only ops console with live polling snapshot, chart
                    drilldown, and decision trail.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge variant={isReady ? "default" : "secondary"}>
                  {isReady ? "ready" : "warming up"}
                </Badge>
                {data ? (
                  <RuntimeBadge
                    paperTrade={data.mode.paperTrade}
                    exchange={data.mode.exchange}
                  />
                ) : null}
              </div>
            </div>
            {data ? (
              <VitalStrip data={data} snapshotError={snapshot.error} />
            ) : null}
          </header>

          <ScrollArea className="flex-1">
            <main id="dashboard-main" className="space-y-4 p-4 md:p-6">
              {snapshot.error && data ? (
                <Alert variant="destructive">
                  <AlertTitle>Snapshot refresh degraded</AlertTitle>
                  <AlertDescription>{snapshot.error}</AlertDescription>
                </Alert>
              ) : null}
              <Outlet />
            </main>
          </ScrollArea>

          {data ? (
            <StatusBar data={data} snapshotError={snapshot.error} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
