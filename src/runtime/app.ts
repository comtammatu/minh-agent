/**
 * Minh (明) — runtime bootstrap.
 *
 * Startup sequence (must match docs/ARCHITECTURE.md §1):
 *   1. Validate window policies; run DB migrations
 *   2. Coin selection (+ HL probe / replace); fail if empty
 *   3. WS subscribe first (bootstrap buffer — live ticks not lost)
 *   4. Start TUI Body (bootstrap / warming UI)
 *   5. PG load candles → memory
 *   6. REST gap-fill / backfill; replace zero-ready coins (bounded rounds)
 *   7. Bootstrap replay from store → flush WS buffer into onCandleTick
 *   8. Mark backfill done; enable PG write-through for live candles
 *   9. Funding / OI polling (exchange-specific)
 *  10. Reset setup generator; init execution; arm DMS / BB heartbeat if live
 *  11. Wire agent ↔ OrderManager ↔ PositionMonitor ↔ InvalidationBridge; restore
 *  12. Wire advisor (if not off), metrics, Telegram; then subscribe agent to pipeline
 *  13. Materialize / bootstrap setups; start coin refresh + staleness watchdog
 *  SIGINT/SIGTERM: stop sync → cancel open Bybit orders (live) → close WS → close DB → exit
 */


import { getAdvisorCache } from "../advisor/index.js";
import { getInvalidationBridge } from "../agent/invalidation-bridge.js";
import { handleJournalAction } from "../agent/journal.js";
import { getOrderManager } from "../agent/order-manager.js";
import {
  getPositionMonitor,
  queryExchangePositions,
} from "../agent/position-monitor.js";
import { getHealthMonitor } from "../agent/self-healing.js";
import { getAgent } from "../agent/trading-agent.js";
import type { ExchangePositionSnapshot } from "../agent/types.js";
import {
  formatAlert,
  sendTelegramAlert,
  startBot,
  stopBot,
} from "../presence/voice.js";
import { getClosedTradeStatsForWallet } from "../analytics/metrics-repo.js";
import { connectToAgent as connectMetrics } from "../analytics/metrics-service.js";
import {
  ADVISOR,
  BACKFILL_CANDLE_COUNT,
  BACKFILL_CANDLE_COUNTS,
  BACKFILL_REPLACEMENT_ROUNDS,
  BB_HEARTBEAT_PATH,
  BB_HEARTBEAT_WRITE_MS,
  BOOTSTRAP_LOAD_BARS,
  BYBIT_FUNDING_REFRESH_MS,
  BYBIT_TOP_COINS_LIMIT,
  CONFLUENCE_MIN,
  DMS_DEADLINE_MS,
  DMS_REFRESH_MS,
  getActiveExchange,
  getAdvisorMode,
  getExecutionMode,
  HOT_CACHE_CAP_BARS,
  isBbWatchdogEnabled,
  isDmsEnabled,
  MIN_CANDLES_FOR_SCAN,
  MIN_CONFIDENCE,
  PLANNING_WINDOW_BARS,
  READY_BARS,
  REGIME_MULTIPLIERS,
  STALENESS_CHECK_INTERVAL_MS,
  STATE_REPLAY_BARS,
  TIMEFRAMES,
  validateWindowPolicies,
  WS_RECONNECT_BACKOFF,
  WS_RECONNECT_INITIAL_MS,
  WS_RECONNECT_MAX_MS,
} from "../config.js";
import {
  bulkUpsertCandles,
  getAllLastTimestamps,
  loadCandles,
  upsertCandle,
} from "../db/candle-repo.js";
import { closeDb, sql } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  getExecution,
  initExecution,
  isExecutionInitialized,
} from "../app/execution.js";
import type { AccountState } from "../execution/exchange-service.js";
import {
  addOiCoin,
  getLatestAssetCtx,
  removeOiCoin,
  startOiFeed,
  stopOiFeed,
} from "../feed/asset-ctx.js";
import { wirePorts, type WiredPorts } from "../app/wire.js";
import type { FeedPort } from "../ports/feed.js";
import { makeBybitFetchRankedFn } from "../feed/bb/bybit-coin-selector.js";
import {
  getBybitFundingRate,
  loadBybitFundingRates,
} from "../feed/bb/bybit-rest.js";
import {
  closeAllBybitTicker,
  subscribeBybitTicker,
  unsubscribeBybitTicker,
} from "../feed/bb/bybit-ticker.js";
import type { CoinSelector, RefreshResult } from "../feed/coin-selector.js";
import { createCoinSelector } from "../feed/coin-selector.js";
import type { IExchangeFeed } from "../feed/exchange-feed.js";
import {
  addFundingCoin,
  removeFundingCoin,
  startFundingPolling,
  stopFundingPolling,
} from "../feed/funding.js";
import {
  checkBookStaleness,
  subscribeOrderBook,
  unsubscribeOrderBook,
} from "../feed/orderbook.js";
import { probeCoins } from "../feed/rest.js";
import {
  candleCount,
  clearCoinData,
  dayChangePctFromUtcDayOpen,
  getCandles,
  setCandles,
  setOnPersist,
} from "../feed/store.js";
import { getSubscriptionCount, unsubscribeCandles } from "../feed/ws.js";
import { clearTuiSink, log } from "../lib/logger.js";
import { resetSetupGenerator } from "../strategy/engine.js";
import {
  bootstrapPipelineFromStore,
  bootstrapReplayFromStore,
  clearCoinState,
  getActiveSetupCoins,
  getActiveSetups,
  getPipelineEmitter,
  getStatus,
  materializeCurrentSetupsFromStore,
  onCandleTick,
} from "../strategy/orchestrator.js";
import type { Candle, CandleInterval } from "../types.js";
import {
  buildLiveWalletStats,
  type LiveWalletStats,
} from "../ui/live-account-stats.js";
import {
  setBackfillDone,
  startTui,
  stopTui,
  type TuiDataSources,
} from "../presence/body.js";
import { mergeExchangeAndTrackedForTui } from "../ui/tui-positions.js";
import { startHeartbeatWriter } from "./heartbeat.js";

function feedPortAsExchangeFeed(port: FeedPort): IExchangeFeed {
  return {
    exchangeId: port.exchange,
    backfill: (coins, onCandles, isLoaded) =>
      port.backfill(coins, onCandles, isLoaded),
    subscribe: (coins, onCandle) => port.subscribeCandles(coins, onCandle),
    closeAll: () => port.close(),
    checkStaleness: () => port.checkStaleness(),
  };
}

// ── Banner (logged inside main() before TUI starts) ────────────────────────

// ── Feed instance — set once at startup ──────────────────────────────────────

// Initialised inside main() after exchange selection.
// Module-level so coin lifecycle helpers can reference it without prop-drilling.
let feed: IExchangeFeed;
let wiredPorts: WiredPorts | null = null;

type ShutdownSafeExchange = {
  cancelAllOpenOrders?: () => Promise<{
    success: boolean;
    error: string | null;
  }>;
};

// ── Bootstrap WS buffer ────────────────────────────────────────────────────
// During bootstrap replay, WS candles are buffered instead of going through
// the full pipeline. Flushed after replay completes.
interface BufferedCandle {
  coin: string;
  interval: CandleInterval;
  candle: Candle;
}
let wsBuffer: BufferedCandle[] | null = null;

/** WS callback: buffer candles during replay, else pass to onCandleTick directly. */
function onCandleTickBuffered(
  coin: string,
  interval: CandleInterval,
  candle: Candle,
): void {
  if (wsBuffer !== null) {
    wsBuffer.push({ coin, interval, candle });
    return;
  }
  onCandleTick(coin, interval, candle);
}

// ── Coin Lifecycle Helpers ──────────────────────────────────────────────────

/** Subscribe all WS feeds for a coin (candles × TFs + L2 book / BB ticker). */
async function subscribeCoin(coin: string): Promise<void> {
  await feed.subscribe([coin], onCandleTickBuffered);
  if (getActiveExchange() === "HL") {
    // L2 book used by OrderManager / HL execution for sizing & mid; not strategy confluence.
    await subscribeOrderBook(coin);
  } else if (getActiveExchange() === "BB") {
    // Ticker fills funding / OI / 1-level book stores for BB.
    subscribeBybitTicker(coin);
  }
}

/** Backfill a single coin (used during mid-run coin additions). */
async function backfillCoin(coin: string): Promise<number> {
  const results = await feed.backfill([coin], (c, interval, candles) => {
    setCandles(c, interval, candles);
  });
  return results[0]?.readyTFs ?? 0;
}

/** Unsubscribe all feeds + clear all state for a coin. */
async function unsubscribeCoin(coin: string): Promise<void> {
  await unsubscribeCandles(coin);
  if (getActiveExchange() === "HL") {
    await unsubscribeOrderBook(coin);
    removeFundingCoin(coin);
    removeOiCoin(coin);
  } else if (getActiveExchange() === "BB") {
    unsubscribeBybitTicker(coin);
  }
  clearCoinData(coin);
  clearCoinState(coin);
}

// ── CoinSelector + onRefresh ────────────────────────────────────────────────

async function onCoinsRefreshed(result: RefreshResult): Promise<void> {
  // Subscribe + backfill new coins
  for (const coin of result.added) {
    log.info("lifecycle", `COIN-ADD | ${coin} — subscribing + backfilling`);
    await subscribeCoin(coin);
    await backfillCoin(coin);
    bootstrapPipelineFromStore([coin]);
    if (getActiveExchange() === "HL") {
      await addFundingCoin(coin);
      addOiCoin(coin);
    }
  }

  // Unsubscribe dropped coins (no active setup — already filtered by CoinSelector)
  for (const coin of result.dropped) {
    log.info("lifecycle", `COIN-DROP | ${coin} — unsubscribing + clearing`);
    await unsubscribeCoin(coin);
  }
}

// Module-level selector — initialized in main() with exchange-aware fetch fn, used by cleanup()
let selector: CoinSelector;

// ── Main ─────────────────────────────────────────────────────────────────────

// Track intervals so we can clear them before reconnect
const activeIntervals: ReturnType<typeof setInterval>[] = [];

/** Stop fn returned by startHeartbeatWriter — set in main() when BB live, cleared in cleanup(). */
let stopHeartbeatWriter: (() => void) | null = null;

/**
 * In-flight HL dead-man-switch arm promise. Tracked at module scope so the
 * graceful-shutdown path can await any pending arm before calling
 * scheduleCancel(undefined) — otherwise a late arm could re-schedule
 * the cancel after the clear and silently kill orders after restart.
 */
let dmsArmInFlight: Promise<void> | null = null;

/** TUI live Account: closed-trade stats for the shared runtime wallet (refreshed from DB). */
let liveWalletStatsCache: LiveWalletStats | null = null;

/** TUI live: last cached account states for the shared runtime wallet. */
let liveAccountStatesCache: Map<string, AccountState> | null = null;

/**
 * TUI live: last HL clearinghouse snapshot (refreshed ~10s). {@link PositionMonitor} is merged
 * synchronously on each TUI read so bot-opened positions appear immediately — caching the merged
 * Map caused empty maps to mask fresh tracked positions until the next refresh.
 */
let liveTuiExchangePositionsCache: ExchangePositionSnapshot[] | null = null;

class StartupFatalError extends Error {}

async function refreshLiveWalletStatsCache(): Promise<void> {
  try {
    const rows = await getClosedTradeStatsForWallet();
    liveWalletStatsCache = buildLiveWalletStats(rows);
  } catch {
    // Transient DB errors: keep previous cache
  }
}

function aggregateAccountStatesForTui(
  m: Map<string, AccountState>,
): AccountState {
  if (m.size === 0) {
    throw new Error("aggregateAccountStatesForTui: empty map");
  }
  let accountValue = 0;
  let totalNtlPos = 0;
  let totalMarginUsed = 0;
  let withdrawable = 0;
  let spotUsdcBalance = 0;
  let effectiveBalance = 0;
  for (const st of m.values()) {
    accountValue += st.accountValue;
    totalNtlPos += st.totalNtlPos;
    totalMarginUsed += st.totalMarginUsed;
    withdrawable += st.withdrawable;
    spotUsdcBalance += st.spotUsdcBalance;
    effectiveBalance += st.effectiveBalance;
  }
  return {
    accountValue,
    totalNtlPos,
    totalMarginUsed,
    withdrawable,
    spotUsdcBalance,
    effectiveBalance,
  };
}

async function refreshLiveAccountStatesForTui(): Promise<void> {
  try {
    if (!isExecutionInitialized()) return;
    liveAccountStatesCache = null;
  } catch {
    // Keep previous cache on HL errors
  }
}

function refreshLiveTuiPositionsCache(): void {
  // Reuse cached snapshots from position-monitor's syncWithExchange — avoids duplicate API calls.
  liveTuiExchangePositionsCache =
    getPositionMonitor().getLastExchangeSnapshots();
}

async function refreshLiveTuiCaches(): Promise<void> {
  await refreshLiveWalletStatsCache();
  await refreshLiveAccountStatesForTui();
  await refreshLiveTuiPositionsCache();
}

async function main(): Promise<void> {
  const activeExchange = getActiveExchange();
  wiredPorts = wirePorts();
  feed = feedPortAsExchangeFeed(wiredPorts.feed);
  log.info(
    "startup",
    `PORTS | ${activeExchange} feed + exchange wired via wirePorts()`,
  );

  // Initialize selector with exchange-aware fetch function and top-coin limit.
  // BB: dynamic fetch from Bybit tickers API (top 50 by OI), no HIP-3.
  // HL: default behavior (fetchRankedCoins from HL API + HIP-3, top 20).
  const fetchRankedFn =
    activeExchange === "BB" ? makeBybitFetchRankedFn() : undefined;
  const topLimit = activeExchange === "BB" ? BYBIT_TOP_COINS_LIMIT : undefined;
  selector = createCoinSelector(
    getActiveSetupCoins,
    onCoinsRefreshed,
    fetchRankedFn,
    topLimit,
  );

  // Banner — logged before TUI starts, so these safely go to console
  const modeTag = process.env.BYBIT_DEMO === "true" ? "DEMO" : "LIVE";
  log.info(
    "startup",
    `Minh (明) v2.0.0 — Autonomous Trading Agent [${modeTag}]`,
  );
  log.info(
    "startup",
    `Config: dynamic top coins × ${TIMEFRAMES.join(",")} | ` +
      `min:${MIN_CONFIDENCE} | confluence:${CONFLUENCE_MIN}+ | ` +
      `regime:${REGIME_MULTIPLIERS.aligned}/${REGIME_MULTIPLIERS.neutral}/${REGIME_MULTIPLIERS.counter}`,
  );

  // 0a. Validate window policies before anything loads data
  validateWindowPolicies();

  // 0b. Log window policy summary
  const fmtPolicy = (p: Record<string, number>) =>
    TIMEFRAMES.map((tf) => `${tf}:${p[tf]}`).join(" ");
  log.info(
    "startup",
    `Window policy | bootstrap: ${fmtPolicy(BOOTSTRAP_LOAD_BARS)}`,
  );
  log.info(
    "startup",
    `Window policy | hot_cache:  ${fmtPolicy(HOT_CACHE_CAP_BARS)}`,
  );
  log.info(
    "startup",
    `Window policy | planning:   ${fmtPolicy(PLANNING_WINDOW_BARS)}`,
  );
  log.info(
    "startup",
    `Window policy | replay:     ${fmtPolicy(STATE_REPLAY_BARS)}`,
  );
  log.info("startup", `Window policy | ready:      ${fmtPolicy(READY_BARS)}`);

  // 0c. Run DB migrations
  await runMigrations(sql);

  // 1. Fetch top coins from HL — fatal if empty at startup (spec requirement)
  //    skipCallback=true: main() handles initial subscribe+backfill in batch (efficient)
  //    onCoinsRefreshed is only for mid-run coin additions/removals
  const _initialResult = await selector.refresh(true);
  let coins = selector.getTrackedCoins();

  if (coins.length === 0) {
    throw new Error(
      "fetchTopCoins returned empty at startup — cannot proceed without coin list",
    );
  }

  const hip3Count = selector.getHip3Coins().length;
  const nativeCount = coins.length - hip3Count;
  log.info(
    "startup",
    `COINS | ${coins.length} coins selected (${nativeCount} native + ${hip3Count} HIP-3)`,
  );

  // 1b. Probe all coins with a quick 1m candle fetch — drop unavailable coins early.
  //     Skip for BB: probeCoins uses HL REST; static Bybit coins are well-known and don't need probing.
  if (activeExchange === "HL") {
    const { valid: validCoins, failed: probeFailed } = await probeCoins(coins);
    if (probeFailed.length > 0) {
      const replacements = selector.replaceFailed(probeFailed);
      if (replacements.length > 0) {
        // Probe replacements too
        const { valid: replValid, failed: replFailed } =
          await probeCoins(replacements);
        if (replFailed.length > 0) {
          selector.replaceFailed(replFailed);
        }
        validCoins.push(...replValid);
      }
      coins = selector.getTrackedCoins();
      log.info(
        "startup",
        `COINS | after probe: ${coins.length} coins (${probeFailed.length} replaced)`,
      );
    }
  }

  // 2. WS subscribe FIRST — capture real-time candles immediately
  //    Enable bootstrap ingress mode: WS candles go to buffer, not full pipeline.
  wsBuffer = [];
  for (const coin of coins) {
    await subscribeCoin(coin);
  }

  // 2b. Start TUI Body immediately — shows backfill progress until ready
  const tuiSources: TuiDataSources = {
    getAgentSnapshot: () => ({
      global: {
        dailyPnl: 0,
        totalConsecutiveLosses: 0,
        globalPaused: false,
        globalPauseReason: null,
        uptime: 0,
      },
      coins: {},
    }),
    getPositions: () => new Map(),
    getStatus: () => getStatus(),
    getHealthReport: () => ({
      overall: "ok",
      uptime: 0,
      rssBytes: process.memoryUsage().rss,
      components: {
        feed: { status: "ok", consecutiveErrors: 0 },
        db: { status: "ok", consecutiveErrors: 0 },
        exchange: { status: "ok", consecutiveErrors: 0 },
      },
    }),
    getAccountState: () => null,
    getSubscriptionCount,
    getTrackedCoins: () => selector.getTrackedCoins(),
    getAssetPrice: (coin: string) => {
      if (activeExchange === "BB") {
        // BB has no separate mark-price feed — use last 1m candle close as price proxy.
        const candles = getCandles(coin, "1m", 1);
        const last = candles.at(-1);
        if (!last) return null;
        return {
          markPrice: last.c,
          funding: getBybitFundingRate(coin),
          dayChangePctUtc: dayChangePctFromUtcDayOpen(coin, last.c),
        };
      }
      const ctx = getLatestAssetCtx(coin);
      if (!ctx) return null;
      return {
        markPrice: ctx.markPrice,
        funding: ctx.funding,
        dayChangePctUtc: dayChangePctFromUtcDayOpen(coin, ctx.markPrice),
      };
    },
    getActiveSetups: () => getActiveSetups(),
    getInvalidationStats: () => ({
      total: 0,
      matched: 0,
      skipped: 0,
      parseFailed: 0,
      actions: {},
      byStrategy: {},
    }),
    getLiveWalletStats: () => liveWalletStatsCache,
    getLiveAccountStates: () => liveAccountStatesCache,
  };
  startTui(tuiSources);

  // 3. Load candles from PG → memory
  const pgTimestamps = await getAllLastTimestamps();
  const _now = Date.now();
  let pgLoadedTotal = 0;

  for (const coin of coins) {
    for (const tf of TIMEFRAMES) {
      const interval = tf as CandleInterval;
      const storeKey = `${coin}|${interval}`;
      const lastPgTs = pgTimestamps.get(storeKey) ?? null;
      const fullCount =
        BACKFILL_CANDLE_COUNTS[interval] ?? BACKFILL_CANDLE_COUNT;

      if (lastPgTs !== null) {
        const pgCandles = await loadCandles(coin, interval, fullCount);
        if (pgCandles.length > 0) {
          setCandles(coin, interval, pgCandles);
          pgLoadedTotal += pgCandles.length;
        }
      }
    }
  }

  if (pgLoadedTotal > 0) {
    log.info("startup", `PG load: ${pgLoadedTotal} candles`);
  }

  // 4. Gap-fill + full backfill via REST (batched, skips coin/TFs already sufficient)
  const backfillResults = await feed.backfill(
    coins,
    (coin, interval, candles) => {
      setCandles(coin, interval, candles);
      bulkUpsertCandles(coin, interval, candles).catch((err) => {
        log.error(
          "persist",
          `bulk upsert failed ${coin}|${interval}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
    (coin, interval) =>
      candleCount(coin, interval) >=
      (READY_BARS[interval as CandleInterval] ?? MIN_CANDLES_FOR_SCAN),
  );
  const tfReady = new Map<string, number>();
  for (const r of backfillResults) tfReady.set(r.coin, r.readyTFs);

  // 4b. Replace coins that completely failed backfill (0 readyTFs)
  //     Pull next-ranked candidates from the full HL list, up to BACKFILL_REPLACEMENT_ROUNDS
  const allFailed = new Set<string>();
  for (let round = 1; round <= BACKFILL_REPLACEMENT_ROUNDS; round++) {
    const failedThisRound = coins.filter(
      (c) => (tfReady.get(c) ?? 0) === 0 && !allFailed.has(c),
    );
    if (failedThisRound.length === 0) break;

    for (const fc of failedThisRound) allFailed.add(fc);
    log.info(
      "lifecycle",
      `COIN-REPLACE | round ${round}: removing ${failedThisRound.join(", ")} (0 readyTFs)`,
    );

    // Unsubscribe failed coins (already subscribed in step 3)
    for (const fc of failedThisRound) {
      await unsubscribeCoin(fc);
    }

    // Get replacements from ranked list
    const replacements = selector.replaceFailed(failedThisRound);
    if (replacements.length === 0) {
      log.info("lifecycle", `COIN-REPLACE | no more candidates available`);
      break;
    }

    log.info("lifecycle", `COIN-REPLACE | adding ${replacements.join(", ")}`);

    // Subscribe + backfill replacements
    for (const rc of replacements) {
      await subscribeCoin(rc);
    }
    const replResults = await feed.backfill(
      replacements,
      (coin, interval, candles) => {
        setCandles(coin, interval, candles);
        bulkUpsertCandles(coin, interval, candles).catch((err) => {
          log.error(
            "persist",
            `bulk upsert failed ${coin}|${interval}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
    );
    for (const r of replResults) tfReady.set(r.coin, r.readyTFs);

    // Update coins list for subsequent steps
    coins = selector.getTrackedCoins();
  }

  if (allFailed.size > 0) {
    log.info(
      "lifecycle",
      `COIN-REPLACE | done — replaced ${allFailed.size} failed coins | now tracking ${coins.length}`,
    );
  }

  // 4c. Bootstrap replay: rebuild multi-stage strategy state from historical candles
  //     snapshot → clear → preseed → global chronological replay → flush WS buffer → materialize
  const replayCount = bootstrapReplayFromStore(coins);
  if (replayCount > 0) {
    log.info("startup", `Replay hydrate: ${replayCount} candles replayed`);
  }

  // 4d. Flush WS buffer: feed buffered live candles through the full pipeline
  const buffered = wsBuffer ?? [];
  wsBuffer = null; // disable buffer — WS candles now go direct to onCandleTick
  if (buffered.length > 0) {
    for (const ev of buffered) {
      onCandleTick(ev.coin, ev.interval, ev.candle);
    }
    log.info("startup", `WS buffer flushed: ${buffered.length} candles`);
  }

  // 4e. Signal TUI: backfill complete → transition to live monitor
  //     NOTE: materialize current setups happens later (step 9b) after agent subscribes to pipeline.
  setBackfillDone();

  // 5. Wire PG write-through for live WS candles (R14: sync write-through)
  //    Wired AFTER backfill so startup uses efficient bulk operations, not per-candle upserts
  //    S13: record health on success/error
  const health = getHealthMonitor();
  setOnPersist((coin, interval, candle) => {
    health.recordSuccess("feed");
    upsertCandle(coin, interval, candle)
      .then(() => health.recordSuccess("db"))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          "persist",
          `upsert failed ${coin}|${interval} t=${candle.t}: ${msg}`,
        );
        health.recordError("db", msg);
      });
  });

  // 6. Start funding + OI polling — HL only (asset-ctx + funding use HL WS/REST)
  if (activeExchange === "HL") {
    await Promise.all([startFundingPolling(coins), startOiFeed(coins)]);
  } else if (activeExchange === "BB") {
    // Load Bybit funding rates once (public endpoint, no auth).
    // Funding settles every 8h — refresh every 4h is sufficient.
    await loadBybitFundingRates();
    activeIntervals.push(
      setInterval(() => void loadBybitFundingRates(), BYBIT_FUNDING_REFRESH_MS),
    );
  }

  // 7. ARMED readiness gate
  const fullyReady = coins.filter(
    (c) => (tfReady.get(c) ?? 0) === TIMEFRAMES.length,
  ).length;
  const partialReady = coins.filter((c) => {
    const r = tfReady.get(c) ?? 0;
    return r > 0 && r < TIMEFRAMES.length;
  }).length;
  log.info(
    "startup",
    `ARMED | ${coins.length} coins: ${fullyReady} fully ready, ${partialReady} partial | ${TIMEFRAMES.length} TFs`,
  );

  // 7b. Single concrete setup generator
  resetSetupGenerator();
  log.info("startup", "STRAT | canonical single-strategy scanner: minh");

  // 7c. Init execution service (single shared wallet per process)
  let executionReady = false;
  try {
    const svc = await initExecution();
    executionReady = true;
    const account = await svc.getAccountState();
    let positions: ExchangePositionSnapshot[] = [];
    try {
      positions = await svc.getPositions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("startup", `POS   | Could not fetch open positions: ${msg}`);
    }
    const acctAddr = svc.getAccountAddress();
    const addrShort = `${acctAddr.slice(0, 6)}…${acctAddr.slice(-4)}`;

    const exchangeName = activeExchange === "BB" ? "Bybit" : "Hyperliquid";
    const executionMode = getExecutionMode();
    log.info(
      "startup",
      executionMode === "paper"
        ? `MODE  | PAPER EXECUTION — simulated fills, no private ${exchangeName} orders`
        : `MODE  | LIVE TRADING — real orders on ${exchangeName}`,
    );
    log.info(
      "startup",
      `ACCT  | ${addrShort} | balance: $${account.effectiveBalance.toFixed(2)} (perp: $${account.accountValue.toFixed(2)} + spot: $${account.spotUsdcBalance.toFixed(2)}) | margin: $${account.totalMarginUsed.toFixed(2)} | free: $${account.withdrawable.toFixed(2)}`,
    );

    if (positions.length > 0) {
      const posLines = positions
        .map((p) => {
          const side = p.size > 0 ? "LONG" : "SHORT";
          const pnlSign = p.unrealizedPnl >= 0 ? "+" : "";
          return `  ${p.coin.padEnd(10)} ${side} ${Math.abs(p.size)} @ $${p.entryPrice.toFixed(2)} | uPnL: ${pnlSign}$${p.unrealizedPnl.toFixed(2)}${p.liquidationPrice ? ` | liq: $${p.liquidationPrice.toFixed(2)}` : ""}`;
        })
        .join("\n");
      log.info(
        "startup",
        `POS   | ${positions.length} open position(s):\n${posLines}`,
      );
    } else {
      log.info("startup", "POS   | no open positions");
    }
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "object"
          ? JSON.stringify(err)
          : String(err);
    if (!executionReady) {
      log.error("startup", `FATAL | Execution init failed: ${msg}`);
      throw new StartupFatalError(`Execution init failed: ${msg}`);
    }
    // Pool initialized but account query failed — non-fatal, continue with degraded state.
    // Common on Bybit Demo Trading when account has no balance yet.
    log.warn(
      "startup",
      `ACCT  | Could not fetch account info (non-fatal): ${msg}`,
    );
  }

  // 7d. Start BB heartbeat writer (live Bybit only). An external watchdog
  //     process (`scripts/bb-watchdog.ts`) reads this file and calls Bybit
  //     cancelAllOpenOrders() if the bot freezes/crashes. Bybit has no native
  //     scheduleCancel, so this is the only crash protection for BB live.
  if (isBbWatchdogEnabled()) {
    stopHeartbeatWriter = startHeartbeatWriter({
      path: BB_HEARTBEAT_PATH,
      writeMs: BB_HEARTBEAT_WRITE_MS,
    });
    log.info(
      "startup",
      `HEARTBEAT | armed | path ${BB_HEARTBEAT_PATH} | write ${BB_HEARTBEAT_WRITE_MS / 1000}s`,
    );
  }

  // 7e. Arm HL dead-man-switch via CrashGuard port (live HL only).
  if (isDmsEnabled() && executionReady && wiredPorts) {
    const guard = wiredPorts.crashGuard;
    const armDms = async (): Promise<void> => {
      try {
        await guard.arm();
        if (guard.status() === "degraded") {
          log.error("dms", "DMS arm failed — crash guard degraded");
        }
      } catch (err) {
        log.error(
          "dms",
          `DMS arm exception: ${err instanceof Error ? err.message : err}`,
        );
      }
    };
    const startArm = (): void => {
      dmsArmInFlight = armDms();
    };
    startArm();
    await dmsArmInFlight;
    if (guard.status() === "armed") {
      log.info(
        "startup",
        `DMS   | armed | deadline ${DMS_DEADLINE_MS / 1000}s | refresh ${DMS_REFRESH_MS / 1000}s`,
      );
    } else {
      log.warn(
        "startup",
        `DMS   | initial arm failed — will retry on next refresh tick (${DMS_REFRESH_MS / 1000}s)`,
      );
    }
    activeIntervals.push(
      setInterval(() => {
        dmsArmInFlight = guard.refresh();
      }, DMS_REFRESH_MS),
    );
  } else if (isDmsEnabled() && executionReady) {
    log.warn(
      "startup",
      "DMS   | CrashGuard port unavailable — not armed",
    );
  }

  // 8. Start health monitor periodic check (S13: Self-Healing)
  health.startPeriodicCheck();

  // 9. Wire agent components for the single-runtime execution loop
  const agent = getAgent();
  const om = getOrderManager();
  const pm = getPositionMonitor();
  const bridge = getInvalidationBridge();

  if (executionReady) {
    om.setExecutionService(getExecution());
  }

  // Load active orders from DB (crash recovery R1)
  await om.loadActiveOrders();

  // Agent → OrderManager (bidirectional).
  // MUST be wired BEFORE subscribeToPipeline + bootstrapPipelineFromStore so that
  // place_order actions emitted during bootstrap are handled (not lost).
  agent.onAction((action) => om.handleAction(action));
  agent.onAction((action) =>
    handleJournalAction(
      action,
      action.type === "log_journal"
        ? agent.getCoinState(action.coin)
        : undefined,
    ),
  );
  om.setAgentDispatch((coin, event) => agent.dispatch(coin, event));
  om.setGlobalPauseCallback((reason) => agent.pauseAll(reason));

  // OrderManager → PositionMonitor: register position on fill (enables TUI display + trail stop)
  om.setPositionOpenCallback((params) => pm.openPosition(params));

  // Crash recovery: re-register positions from DB-filled orders for coins still open on exchange.
  // PositionMonitor state is in-memory — lost on restart → positions show as 'ext' without this.
  try {
    const openSnaps = await queryExchangePositions();
    if (openSnaps) om.restoreOpenPositions(openSnaps);
  } catch (err) {
    log.warn(
      "agent",
      `restoreOpenPositions failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }

  // Agent → PositionMonitor (dispatch back, keyed by coin only)
  pm.setAgentDispatch((coin, event) => agent.dispatch(coin, event));

  // PositionMonitor → OrderManager: trail stop SL updates go directly to exchange
  pm.setUpdateStopCallback((parentOrderId, newSlPrice) =>
    om.modifySLPrice(parentOrderId, newSlPrice),
  );

  // PositionMonitor → OrderManager: partial closes must submit reduce-only
  // exchange closes before local size is reduced.
  pm.setPartialCloseCallback((positionId, closePct, closeSize) =>
    om.handleAction({ type: "partial_close", positionId, closePct, closeSize }),
  );

  // PositionMonitor → OrderManager: monitor-initiated full closes (thesis)
  // must submit a REAL reduce-only exchange close; the agent stays
  // IN_POSITION until reconcile confirms the position is gone.
  pm.setCloseCallback((positionId, reason) =>
    om.handleAction({ type: "close_position", positionId, reason }),
  );

  // Wire equity updates from PositionMonitor back into the agent for portfolio risk checks.
  pm.setEquityCallback((equity) => agent.setAccountEquity(equity));

  // Start exchange sync heartbeat (R3: 10s interval)
  pm.startSync();

  // Order fill timeout watchdog: release stuck ENTERING states when limit orders never fill.
  // ORDER_FILL_TIMEOUT_MS = 5 min; check every 60s is sufficient.
  activeIntervals.push(setInterval(() => void om.checkTimeouts(), 60_000));

  // Wire metrics service: refresh matviews after each trade close
  connectMetrics(agent);

  // Wire advisor: inject stats cache into pre-entry gate and refresh on trade
  // close + periodic interval. Fail-open by design.
  // Wired BEFORE subscribeToPipeline so verdicts cover bootstrap setups too.
  const advisorMode = getAdvisorMode();
  if (advisorMode !== "off") {
    const advisorCache = getAdvisorCache();
    agent.setAdvisor(advisorCache, advisorMode);
    void advisorCache.refresh();
    activeIntervals.push(
      setInterval(() => void advisorCache.refresh(), ADVISOR.refreshMs),
    );
    agent.onTradeClose(() => void advisorCache.refresh());
    log.info(
      "startup",
      `ADVSR | mode ${advisorMode} | stats refresh ${ADVISOR.refreshMs / 1000}s`,
    );
  }

  // Telegram trade alerts (HTML) — fire-and-forget
  // MUST be wired BEFORE bootstrapPipelineFromStore so bootstrap signals reach Telegram.
  agent.onAction((action) => {
    const msg = formatAlert(action);
    if (msg)
      void sendTelegramAlert(msg.text, globalThis.fetch, {
        parseMode: msg.parseMode,
      });
  });

  // Start Telegram bot (long-polling command interface)
  await startBot();

  // Agent ← Pipeline (setup events)
  // Subscribed AFTER all agent.onAction handlers are wired so bootstrap actions are not lost.
  agent.subscribeToPipeline(getPipelineEmitter());

  // InvalidationBridge ← Pipeline (invalidation events) → Agent
  bridge.connect(getPipelineEmitter(), agent);

  // 9b. Materialize current-bar setups + seed WS dedup (AFTER agent subscribes to pipeline)
  //     If replay ran, state is already rebuilt — materialize emits current setups to agent.
  //     If no replay (STATE_REPLAY_BARS all 0), falls back to bootstrapPipelineFromStore.
  if (replayCount > 0) {
    materializeCurrentSetupsFromStore(coins);
  } else {
    bootstrapPipelineFromStore(coins);
  }

  log.info(
    "agent",
    "Agent wired: minh + execution + order manager + position monitor + invalidation bridge + Telegram bot",
  );

  // 10. Start coin refresh loop
  selector.startRefreshLoop();

  // 11. Upgrade TUI data sources — agent + health now initialized
  tuiSources.getAgentSnapshot = () => agent.getSnapshot();
  tuiSources.getPositions = () => {
    const exchangeSnap = liveTuiExchangePositionsCache;
    if (exchangeSnap === null) return pm.getPositions();
    return mergeExchangeAndTrackedForTui(pm.getPositions(), exchangeSnap);
  };
  tuiSources.getHealthReport = () => health.getReport();
  tuiSources.getAccountState = async () => {
    try {
      if (liveAccountStatesCache && liveAccountStatesCache.size > 0) {
        if (!isExecutionInitialized()) return null;
        return aggregateAccountStatesForTui(liveAccountStatesCache);
      }
      // Reuse cached state from position-monitor's syncWithExchange — avoids duplicate API calls.
      return pm.getLastAccountState();
    } catch {
      return null;
    }
  };
  tuiSources.getLiveAccountStates = () => liveAccountStatesCache;
  tuiSources.getInvalidationStats = () => getInvalidationBridge().getStats();

  void refreshLiveTuiCaches();
  activeIntervals.push(setInterval(() => void refreshLiveTuiCaches(), 10_000));

  // 12. Staleness watchdog (candles + order book — book only on HL)
  activeIntervals.push(
    setInterval(() => {
      feed.checkStaleness();
      if (activeExchange === "HL") checkBookStaleness();
    }, STALENESS_CHECK_INTERVAL_MS),
  );

  // Keep alive — resolve when WS dies (detected via staleness or thrown error)
  await new Promise(() => {
    // intentionally never resolves — process stays alive via setIntervals
  });
}

/** Clean up intervals, WS connections, refresh loop, polling, agent sync, and TUI before reconnect/shutdown. */
async function cleanup(
  reason: "reconnect" | "shutdown" = "reconnect",
): Promise<void> {
  clearTuiSink();
  stopTui();
  selector.stopRefreshLoop();
  getPositionMonitor().stopSync();
  stopBot();
  for (const id of activeIntervals) clearInterval(id);
  activeIntervals.length = 0;
  stopFundingPolling();
  await stopOiFeed();
  await feed.closeAll();
  if (getActiveExchange() === "HL" && reason === "shutdown" && isDmsEnabled()) {
    if (dmsArmInFlight) {
      try {
        await dmsArmInFlight;
      } catch {
        /* errors logged inside armDms */
      }
      dmsArmInFlight = null;
    }
    try {
      await wiredPorts?.crashGuard.disarm();
    } catch (err) {
      log.error(
        "shutdown",
        `DMS disarm exception: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (getActiveExchange() === "BB") {
    // Stop heartbeat writer + delete file. On 'shutdown' this signals the
    // watchdog that we stopped intentionally (no cancel needed). On 'reconnect'
    // it's also correct to drop the file — the writer restarts in main() when
    // the BB live gate is still satisfied.
    if (stopHeartbeatWriter) {
      try {
        stopHeartbeatWriter();
      } catch (err) {
        log.error(
          "shutdown",
          `heartbeat stop exception: ${err instanceof Error ? err.message : err}`,
        );
      }
      stopHeartbeatWriter = null;
    }
    if (reason === "shutdown") {
      try {
        if (isExecutionInitialized()) {
          const svc = getExecution() as ShutdownSafeExchange;
          if (typeof svc.cancelAllOpenOrders === "function") {
            const result = await svc.cancelAllOpenOrders();
            if (!result.success) {
              log.error(
                "shutdown",
                `Bybit cancel-all-on-exit failed: ${result.error}`,
              );
            }
          }
        }
      } catch (err) {
        log.error(
          "shutdown",
          `Bybit cancel-all-on-exit exception: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    closeAllBybitTicker();
  }
  resetSetupGenerator();
}

/** Run the runtime with exponential backoff reconnection on failure. */
export async function runRuntime(): Promise<never> {
  let delay = WS_RECONNECT_INITIAL_MS;
  let shuttingDown = false;

  const handleShutdown = async (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown", `Received ${signal}; closing connections...`);
    getHealthMonitor().stopPeriodicCheck();
    getPositionMonitor().stopSync();
    await cleanup("shutdown");
    await closeDb();
    log.info("shutdown", "Minh stopped gracefully.");
    process.exit(0);
  };

  // Shutdown handlers — register once, outside retry loop
  process.on("SIGINT", () => {
    void handleShutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleShutdown("SIGTERM");
  });

  while (true) {
    try {
      await main();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof StartupFatalError) {
        log.error("lifecycle", `STARTUP FATAL | ${msg}`);
        try {
          await cleanup();
        } catch {
          // best-effort cleanup before process exit
        }
        throw err;
      }
      log.error("lifecycle", `CONNECTION LOST | ${msg}`);
      log.info(
        "lifecycle",
        `RECONNECT | retrying in ${Math.round(delay / 1000)}s...`,
      );

      // Tear down everything before retry
      await cleanup();

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * WS_RECONNECT_BACKOFF, WS_RECONNECT_MAX_MS);

      log.info(
        "lifecycle",
        "RECONNECT | restarting subscriptions + backfill...",
      );
    }
  }
}
