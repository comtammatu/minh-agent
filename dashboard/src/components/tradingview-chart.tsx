import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartOverlays } from "@/lib/api";
import type { ChartLine, ChartResolution } from "@/lib/dashboard-types";
import {
  createTradingViewDatafeed,
  ensureTradingView,
  type TradingViewChartApi,
  type TradingViewWidget,
} from "@/lib/tradingview";

interface TradingViewChartProps {
  ticker: string | null;
  resolution: ChartResolution;
  showMarks: boolean;
  showLines: boolean;
}

async function syncHorizontalLines(
  chart: TradingViewChartApi,
  lines: ChartLine[],
  entities: Array<string | number>,
): Promise<Array<string | number>> {
  for (const entity of entities) {
    chart.removeEntity(entity);
  }
  const nextEntities: Array<string | number> = [];
  const now = Math.floor(Date.now() / 1000);
  for (const line of lines) {
    const entity = await chart.createShape(
      { time: now, price: line.price },
      {
        shape: "horizontal_line",
        text: line.text,
        lock: true,
        disableSelection: true,
        disableSave: true,
        disableUndo: true,
        overrides: {
          linecolor: line.color,
          textcolor: line.color,
          linewidth: 1,
        },
      },
    );
    nextEntities.push(entity);
  }
  return nextEntities;
}

export function TradingViewChart({
  ticker,
  resolution,
  showMarks,
  showLines,
}: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<TradingViewWidget | null>(null);
  const lineEntitiesRef = useRef<Array<string | number>>([]);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const overlays = useChartOverlays(ticker);

  useEffect(() => {
    if (!ticker || !containerRef.current) return;
    let cancelled = false;

    const mount = async (): Promise<void> => {
      try {
        setError(null);
        setIsReady(false);
        const tv = await ensureTradingView();
        if (cancelled || !containerRef.current) return;

        const widget = new tv.widget({
          symbol: ticker,
          interval: resolution,
          container: containerRef.current,
          library_path: "/charting_library/",
          locale: "en",
          datafeed: createTradingViewDatafeed(),
          autosize: true,
          timezone: "Etc/UTC",
          theme: "dark",
          disabled_features: [
            "header_compare",
            "header_symbol_search",
            "symbol_search_hot_key",
            "timeframes_toolbar",
            "use_localstorage_for_settings",
          ],
          overrides: {
            "paneProperties.background": "#090b0f",
            "paneProperties.vertGridProperties.color": "rgba(255,255,255,0.05)",
            "paneProperties.horzGridProperties.color": "rgba(255,255,255,0.05)",
            "symbolWatermarkProperties.transparency": 94,
            "mainSeriesProperties.candleStyle.upColor": "#18b886",
            "mainSeriesProperties.candleStyle.downColor": "#ef5350",
            "mainSeriesProperties.candleStyle.borderUpColor": "#18b886",
            "mainSeriesProperties.candleStyle.borderDownColor": "#ef5350",
            "mainSeriesProperties.candleStyle.wickUpColor": "#18b886",
            "mainSeriesProperties.candleStyle.wickDownColor": "#ef5350",
          },
        });

        widget.onChartReady(() => {
          if (cancelled) return;
          widgetRef.current = widget;
          setIsReady(true);
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void mount();

    return () => {
      cancelled = true;
      const widget = widgetRef.current;
      if (widget) {
        for (const entity of lineEntitiesRef.current) {
          widget.activeChart().removeEntity(entity);
        }
        lineEntitiesRef.current = [];
        widget.remove();
        widgetRef.current = null;
      }
    };
  }, [resolution, ticker]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !isReady) return;
    const chart = widget.activeChart();
    if (showMarks) {
      chart.refreshMarks();
    } else {
      chart.clearMarks();
    }
  }, [isReady, showMarks]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !isReady) return;
    const chart = widget.activeChart();
    if (!showLines) {
      for (const entity of lineEntitiesRef.current) {
        chart.removeEntity(entity);
      }
      lineEntitiesRef.current = [];
      return;
    }
    const lines = overlays.data?.lines ?? [];
    void syncHorizontalLines(chart, lines, lineEntitiesRef.current).then(
      (nextEntities) => {
        lineEntitiesRef.current = nextEntities;
      },
    );
  }, [isReady, overlays.data?.lines, showLines]);

  if (!ticker) {
    return (
      <Alert>
        <AlertTitle>No market selected</AlertTitle>
        <AlertDescription>
          Choose a coin from the watchlist to mount the TradingView chart.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="relative h-[620px] overflow-hidden rounded-md border bg-background">
      {!isReady ? <Skeleton className="absolute inset-0" /> : null}
      {error ? (
        <div className="absolute inset-4 z-10">
          <Alert variant="destructive">
            <AlertTitle>Chart failed to load</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
