import path from "node:path";
import type { AdvisorSnapshot } from "../advisor/index.js";
import { getAdvisorCache } from "../advisor/index.js";
import { getJournalEntries } from "../agent/journal.js";
import type { JournalEntry, JournalEventType } from "../agent/types.js";
import { getLiveMetrics } from "../analytics/metrics-service.js";
import type { LiveMetrics } from "../analytics/types.js";
import { getAdvisorMode, getExecutionMode, isPaperMode } from "../config.js";
import { log } from "../lib/logger.js";
import { queryMemories } from "../memory/index.js";
import type {
  DashboardAccountSnapshot,
  DashboardAdvisorResponse,
  DashboardJournalRow,
  DashboardPositionRow,
  DashboardServerState,
  DashboardSnapshotResponse,
  DashboardWatchlistRow,
} from "./contracts.js";
import {
  createOperatorActionDeps,
  handleOperatorFlatten,
  handleOperatorPause,
  handleOperatorResume,
  type OperatorActionDeps,
  readJsonBody,
} from "./operator-actions.js";

const DASHBOARD_DIST_DIR = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "dashboard",
  "dist",
);
/** Latest pattern_insight memories returned by GET /api/advisor. */
const ADVISOR_INSIGHT_LIMIT = 5;
const JOURNAL_EVENTS: JournalEventType[] = [
  "signal",
  "enter",
  "exit",
  "skip",
  "invalidate",
  "circuit_break",
  "pause",
  "resume",
  "error",
  "operator",
  "advisor",
];

type AccountStateLike = {
  effectiveBalance: number;
  accountValue: number;
  spotUsdcBalance: number;
  totalMarginUsed: number;
  withdrawable: number;
};

export interface DashboardFetchHandlerOptions {
  state: DashboardServerState;
  getSummaryMetrics?: () => Promise<LiveMetrics>;
  readJournal?: typeof getJournalEntries;
  getAdvisorSnapshot?: () => AdvisorSnapshot | null;
  readMemories?: typeof queryMemories;
  distDir?: string;
  operatorActions?: OperatorActionDeps;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound(message: string): Response {
  return json({ error: message }, 404);
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function clampLimit(
  value: string | null,
  fallback: number,
  max: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function serializeJournal(entries: JournalEntry[]): DashboardJournalRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    ts: entry.ts.toISOString(),
    eventType: entry.eventType,
    coin: entry.coin,
    details: entry.details,
    agentState: entry.agentState,
    exchange: entry.exchange,
  }));
}

function computeUnrealizedPnl(
  position: {
    side: "long" | "short";
    entryPrice: number;
    currentSize: number;
  },
  markPrice: number | null,
): number | null {
  if (markPrice === null) return null;
  const direction = position.side === "long" ? 1 : -1;
  return (
    (markPrice - position.entryPrice) *
    Math.abs(position.currentSize) *
    direction
  );
}

function serializePositions(
  state: DashboardServerState,
): DashboardPositionRow[] {
  return [...state.sources.getPositions().values()].map((position) => {
    const asset = state.sources.getAssetPrice(position.coin);
    return {
      positionId:
        position.positionId ??
        position.rowKey ??
        `${position.coin}:${position.side}`,
      coin: position.coin,
      side: position.side,
      leverage: position.leverage,
      entryPrice: position.entryPrice,
      currentSize: position.currentSize,
      slPrice: position.slPrice,
      tpPrice: position.tpPrice,
      exchangeOnly: position.exchangeOnly === true,
      markPrice: asset?.markPrice ?? null,
      unrealizedPnl: computeUnrealizedPnl(position, asset?.markPrice ?? null),
    };
  });
}

function serializeWatchlist(
  state: DashboardServerState,
): DashboardWatchlistRow[] {
  return state.sources.getStatus().map((status) => {
    const asset = state.sources.getAssetPrice(status.coin);
    return {
      coin: status.coin,
      interval: status.interval,
      regime: status.regime,
      bias: status.bias,
      biasConfidence: status.biasConfidence,
      confluenceGrade: status.confluenceGrade,
      activeCount: status.activeCount,
      lastUpdateAt: status.lastUpdateAt,
      markPrice: asset?.markPrice ?? null,
      funding: asset?.funding ?? null,
      dayChangePctUtc: asset?.dayChangePctUtc ?? null,
    };
  });
}

function serializeSetups(state: DashboardServerState) {
  return state.sources.getActiveSetups().map((setup) => ({
    id: setup.id,
    coin: setup.coin,
    interval: setup.interval,
    side: setup.side,
    confidence: setup.confidence,
    entryPrice: setup.entryPrice,
    slPrice: setup.slPrice,
    tpPrice: setup.tpPrice,
    detectedAt: setup.detectedAt,
  }));
}

function buildAccountSnapshot(
  state: DashboardServerState,
  positions: DashboardPositionRow[],
  accountState: AccountStateLike | null,
): DashboardAccountSnapshot {
  const liveWalletStats = state.sources.getLiveWalletStats();
  const unrealizedPnl = positions.reduce(
    (sum, position) => sum + (position.unrealizedPnl ?? 0),
    0,
  );

  return {
    source: "live",
    balance: accountState?.effectiveBalance ?? null,
    equity: accountState?.accountValue ?? null,
    available: accountState?.withdrawable ?? null,
    marginUsed: accountState?.totalMarginUsed ?? null,
    withdrawable: accountState?.withdrawable ?? null,
    spotUsdcBalance: accountState?.spotUsdcBalance ?? null,
    unrealizedPnl,
    wins: liveWalletStats?.wins ?? 0,
    losses: liveWalletStats?.losses ?? 0,
    tradeCount: liveWalletStats?.tradeCount ?? 0,
    winRate: liveWalletStats?.winRate ?? 0,
  };
}

async function serveStaticFile(filePath: string): Promise<Response | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return new Response(file);
}

function relativePathFromPrefix(
  pathname: string,
  prefix: string,
): string[] | null {
  if (!pathname.startsWith(prefix)) return null;
  const relative = pathname.slice(prefix.length);
  const segments = relative.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) return null;
  return segments;
}

async function serveDashboardApp(
  pathname: string,
  distDir: string,
): Promise<Response> {
  const segments = relativePathFromPrefix(pathname, "/dashboard");
  if (segments === null) return notFound("Invalid dashboard path");

  if (pathname === "/dashboard") {
    return Response.redirect(
      new URL("/dashboard/", "http://localhost").toString(),
      307,
    );
  }

  if (pathname === "/dashboard/" || segments.length === 0) {
    const fileResponse = await serveStaticFile(
      path.join(distDir, "index.html"),
    );
    return (
      fileResponse ??
      html(`
      <!doctype html>
      <html lang="en">
        <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Minh Dashboard</title></head>
        <body><main style="padding:32px;font-family:ui-monospace;background:#09090b;color:#f4f4f5;">Run <code>bun run dashboard:build</code> to generate the dashboard bundle.</main></body>
      </html>
    `)
    );
  }

  const rel = segments.join("/");
  const requestPath = pathname === "/dashboard/" ? "index.html" : rel;
  const hasExtension = requestPath.includes(".");
  const candidatePath = hasExtension
    ? path.join(distDir, requestPath)
    : path.join(distDir, "index.html");

  const fileResponse = await serveStaticFile(candidatePath);
  if (fileResponse !== null) return fileResponse;

  return html(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Minh Dashboard</title>
        <style>
          body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #09090b; color: #f4f4f5; display: grid; place-items: center; min-height: 100vh; margin: 0; }
          main { max-width: 720px; padding: 32px; border: 1px solid #27272a; border-radius: 20px; background: linear-gradient(180deg, rgba(24,24,27,0.96), rgba(9,9,11,0.98)); }
          code { color: #86efac; }
        </style>
      </head>
      <body>
        <main>
          <h1>Dashboard build not found</h1>
          <p>Run <code>bun run dashboard:build</code> to generate the web UI bundle. API routes remain available under <code>/api/*</code>.</p>
        </main>
      </body>
    </html>
  `);
}

export function createDashboardFetchHandler(
  options: DashboardFetchHandlerOptions,
) {
  const readJournal = options.readJournal ?? getJournalEntries;
  const getSummaryMetrics = options.getSummaryMetrics ?? getLiveMetrics;
  const getAdvisorSnapshot =
    options.getAdvisorSnapshot ?? (() => getAdvisorCache().getSnapshot());
  const readMemories = options.readMemories ?? queryMemories;
  const distDir = options.distDir ?? DASHBOARD_DIST_DIR;
  const operatorActions = options.operatorActions ?? createOperatorActionDeps();

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/") {
      return Response.redirect(
        new URL("/dashboard/", request.url).toString(),
        307,
      );
    }

    try {
      if (pathname === "/api/dashboard/snapshot") {
        const [metrics, journal, maybeAccountState] = await Promise.all([
          getSummaryMetrics(),
          readJournal({ limit: 12, exchange: options.state.activeExchange }),
          options.state.sources.getAccountState()?.catch(() => null) ??
            Promise.resolve(null),
        ]);

        const positions = serializePositions(options.state);
        const agentGlobal = options.state.sources.getAgentSnapshot().global;
        const snapshot: DashboardSnapshotResponse = {
          bootstrap: {
            phase: options.state.getBootstrapPhase(),
            trackedCoins: options.state.sources.getTrackedCoins(),
          },
          mode: {
            exchange: options.state.activeExchange,
            executionMode: getExecutionMode(),
            paperTrade: isPaperMode(),
          },
          operator: {
            globalPaused: agentGlobal.globalPaused,
            pauseReason: agentGlobal.globalPauseReason,
          },
          health: options.state.sources.getHealthReport(),
          account: buildAccountSnapshot(
            options.state,
            positions,
            maybeAccountState,
          ),
          positions,
          watchlist: serializeWatchlist(options.state),
          activeSetups: serializeSetups(options.state),
          summaryMetrics: metrics,
          recentJournal: serializeJournal(journal),
        };
        return json(snapshot);
      }

      if (pathname === "/api/dashboard/journal") {
        const coin = url.searchParams.get("coin")?.trim() || undefined;
        const eventType = url.searchParams.get("eventType")?.trim();
        if (
          eventType &&
          !JOURNAL_EVENTS.includes(eventType as JournalEventType)
        ) {
          return badRequest(`Unsupported journal event type "${eventType}"`);
        }
        const limit = clampLimit(url.searchParams.get("limit"), 100, 500);
        const filter = {
          limit,
          exchange: options.state.activeExchange,
          ...(coin ? { coin } : {}),
          ...(eventType ? { eventType: eventType as JournalEventType } : {}),
        };
        const rows = await readJournal(filter);
        return json({ rows: serializeJournal(rows) });
      }

      if (pathname === "/api/advisor") {
        const snapshot = getAdvisorSnapshot();
        // Fail-open: insight read failure must not take down the advisor surface.
        const insights = await readMemories({
          category: "pattern_insight",
          limit: ADVISOR_INSIGHT_LIMIT,
        }).catch(() => []);
        const buckets = snapshot
          ? [...snapshot.buckets.values()]
              .sort((a, b) => b.trades - a.trades)
              .map((bucket) => ({
                key: bucket.key,
                trades: bucket.trades,
                wins: bucket.wins,
                losses: bucket.losses,
                smoothedWinRate: bucket.smoothedWinRate,
                avgR: bucket.avgR,
              }))
          : [];
        const advisor: DashboardAdvisorResponse = {
          mode: getAdvisorMode(),
          builtAt: snapshot?.builtAt ?? null,
          sampleSize: snapshot?.sampleSize ?? 0,
          buckets,
          insights: [...insights]
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((memory) => ({
              content: memory.content,
              createdAt: memory.createdAt.toISOString(),
              metadata: memory.metadata,
            })),
        };
        return json(advisor);
      }

      if (pathname === "/api/operator/flatten") {
        if (request.method !== "POST") {
          return json(
            { error: "POST required", code: "method_not_allowed" },
            405,
          );
        }
        const body = await readJsonBody(request);
        const result = await handleOperatorFlatten(body, operatorActions);
        if ("code" in result) {
          const status =
            result.code === "missing_confirm"
              ? 400
              : result.code === "action_failed"
                ? 500
                : 400;
          return json(result, status);
        }
        return json(result);
      }

      if (pathname === "/api/operator/pause") {
        if (request.method !== "POST") {
          return json(
            { error: "POST required", code: "method_not_allowed" },
            405,
          );
        }
        const body = await readJsonBody(request);
        const result = await handleOperatorPause(body, operatorActions);
        if ("code" in result) {
          const status = result.code === "missing_confirm" ? 400 : 500;
          return json(result, status);
        }
        return json(result);
      }

      if (pathname === "/api/operator/resume") {
        if (request.method !== "POST") {
          return json(
            { error: "POST required", code: "method_not_allowed" },
            405,
          );
        }
        const body = await readJsonBody(request);
        const result = await handleOperatorResume(body, operatorActions);
        if ("code" in result) {
          const status = result.code === "missing_confirm" ? 400 : 500;
          return json(result, status);
        }
        return json(result);
      }

      if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
        return serveDashboardApp(pathname, distDir);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("dashboard", `Request failed ${pathname}: ${message}`);
      return json({ error: message }, 500);
    }

    return notFound(`No route for ${pathname}`);
  };
}
