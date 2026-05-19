/**
 * Minh (明) — runtime bootstrap.
 *
 * Startup sequence:
 *   0. Run DB migrations
 *   1. CoinSelector: fetch top coins from HL by OI
 *   2. WS subscribe all coins FIRST (capture real-time immediately)
 *   3. Load candles from PG → memory
 *   4. Gap-fill + REST backfill (batched, skips coin/TFs already sufficient)
 *   5. Wire PG write-through for live WS candles
 *   6. Start funding + OI polling
 *   7. Print ARMED + coin counts
 *   8. Start health monitor
 *   9. Wire agent: TradingAgent ↔ OrderManager ↔ PositionMonitor + InvalidationBridge
 *  10. Start coin refresh loop (1h interval)
 *  11. setInterval: STATUS line every 60s
 *  12. setInterval: staleness check every 30s
 *  SIGINT/SIGTERM: stop sync → cancel open Bybit orders (live) → close WS → close DB → exit
 */

import {
  TIMEFRAMES,
  TIMEFRAME_MS,
  STALENESS_CHECK_INTERVAL_MS,

  MIN_CONFIDENCE,
  CONFLUENCE_MIN,
  REGIME_MULTIPLIERS,
  WS_RECONNECT_INITIAL_MS,
  WS_RECONNECT_MAX_MS,
  WS_RECONNECT_BACKOFF,
  BACKFILL_CANDLE_COUNTS,
  BACKFILL_CANDLE_COUNT,
  BACKFILL_REPLACEMENT_ROUNDS,
  MIN_CANDLES_FOR_SCAN,
  validateWindowPolicies,
  BOOTSTRAP_LOAD_BARS,
  HOT_CACHE_CAP_BARS,
  PLANNING_WINDOW_BARS,
  STATE_REPLAY_BARS,
  READY_BARS,
  getActiveExchange,
  BYBIT_TOP_COINS_LIMIT,
  BYBIT_FUNDING_REFRESH_MS,
} from '../config.js'
import { probeCoins } from '../feed/rest.js'
import { setCandles, clearCoinData, setOnPersist, candleCount, dayChangePctFromUtcDayOpen, getCandles } from '../feed/store.js'
import { unsubscribeCandles, getSubscriptionCount } from '../feed/ws.js'
import type { IExchangeFeed } from '../feed/exchange-feed.js'
import { HLFeed } from '../feed/hl-feed.js'
import { BybitFeed } from '../feed/bybit/bybit-feed.js'
import { makeBybitFetchRankedFn } from '../feed/bybit/bybit-coin-selector.js'
import { loadBybitFundingRates, getBybitFundingRate } from '../feed/bybit/bybit-rest.js'
import { subscribeBybitTrades, unsubscribeBybitTrades, closeAllBybitTrades } from '../feed/bybit/bybit-trades.js'
import { subscribeBybitTicker, unsubscribeBybitTicker, closeAllBybitTicker } from '../feed/bybit/bybit-ticker.js'
import { startFundingPolling, stopFundingPolling, addFundingCoin, removeFundingCoin } from '../feed/funding.js'
import { startOiFeed, stopOiFeed, addOiCoin, removeOiCoin } from '../feed/asset-ctx.js'
import { subscribeTrades, unsubscribeTrades } from '../feed/trades.js'
import { subscribeOrderBook, unsubscribeOrderBook, checkBookStaleness } from '../feed/orderbook.js'
import { createCoinSelector } from '../feed/coin-selector.js'
import type { RefreshResult, CoinSelector } from '../feed/coin-selector.js'
import {
  onCandleTick,
  getStatus,
  getActiveSetups,
  getActiveSetupCoins,
  clearCoinState,
  bootstrapPipelineFromStore,
  bootstrapReplayFromStore,
  materializeCurrentSetupsFromStore,
} from '../strategy/orchestrator.js'
import type { Candle } from '../types.js'
import { sql, closeDb } from '../db/connection.js'
import { runMigrations } from '../db/migrate.js'
import { getClosedTradeStatsForWallet } from '../analytics/metrics-repo.js'
import { buildLiveWalletStats, type LiveWalletStats } from '../ui/live-account-stats.js'
import { mergeExchangeAndTrackedForTui } from '../ui/tui-positions.js'
import type { ExchangePositionSnapshot } from '../agent/types.js'
import type { AccountState } from '../execution/exchange-service.js'
import { getExchangePool, type ExchangePool } from '../execution/exchange-pool.js'
import {
  upsertCandle,
  bulkUpsertCandles,
  getAllLastTimestamps,
  loadCandles,
  computeGapStart,
  shouldGapFill,
} from '../db/candle-repo.js'
import { createWriteStream, type WriteStream } from 'fs'
import { log, setTuiSink, clearTuiSink } from '../lib/logger.js'
import { getHealthMonitor } from '../agent/self-healing.js'
import { startTui, stopTui, setBackfillDone, type TuiDataSources } from '../ui/tui.jsx'
import { getLatestAssetCtx } from '../feed/asset-ctx.js'
import { getPipelineEmitter } from '../strategy/orchestrator.js'
import { getAgent } from '../agent/trading-agent.js'
import { getOrderManager } from '../agent/order-manager.js'
import { getPositionMonitor, queryExchangePositions } from '../agent/position-monitor.js'
import { getInvalidationBridge } from '../agent/invalidation-bridge.js'
import { startBot, stopBot, formatAlert, sendTelegramAlert } from '../alert/telegram/index.js'
import { connectToAgent as connectMetrics } from '../analytics/metrics-service.js'
import { resetSetupGenerator } from '../strategy/engine.js'
import type { CandleInterval } from '../types.js'
import { startDashboardServer, stopDashboardServer } from '../server/index.js'
import type { DashboardBootstrapPhase } from '../server/contracts.js'

// ── Banner (logged inside main() before TUI starts) ────────────────────────

// ── Feed instance — set once at startup ──────────────────────────────────────

// Initialised inside main() after exchange selection.
// Module-level so coin lifecycle helpers can reference it without prop-drilling.
let feed: IExchangeFeed

type ShutdownSafeExchange = {
  cancelAllOpenOrders?: () => Promise<{ success: boolean; error: string | null }>
}

// ── TUI log file sink — captures all log output while TUI runs ───────────────
let tuiLogStream: WriteStream | null = null
let dashboardBootstrapPhase: DashboardBootstrapPhase = 'warming_up'

// ── Bootstrap WS buffer ────────────────────────────────────────────────────
// During bootstrap replay, WS candles are buffered instead of going through
// the full pipeline. Flushed after replay completes.
interface BufferedCandle { coin: string; interval: CandleInterval; candle: Candle }
let wsBuffer: BufferedCandle[] | null = null

/** WS callback: buffer candles during replay, else pass to onCandleTick directly. */
function onCandleTickBuffered(coin: string, interval: CandleInterval, candle: Candle): void {
  if (wsBuffer !== null) {
    wsBuffer.push({ coin, interval, candle })
    return
  }
  onCandleTick(coin, interval, candle)
}

// ── Coin Lifecycle Helpers ──────────────────────────────────────────────────

/** Subscribe all WS feeds for a coin (candles × TFs + trades + orderbook). */
async function subscribeCoin(coin: string): Promise<void> {
  await feed.subscribe([coin], onCandleTickBuffered)
  if (getActiveExchange() === 'HL') {
    await subscribeTrades(coin)
    await subscribeOrderBook(coin)
  } else if (getActiveExchange() === 'BB') {
    subscribeBybitTrades(coin)
    subscribeBybitTicker(coin)
  }
}

/** Backfill a single coin (used during mid-run coin additions). */
async function backfillCoin(coin: string): Promise<number> {
  const results = await feed.backfill([coin], (c, interval, candles) => {
    setCandles(c, interval, candles)
  })
  return results[0]?.readyTFs ?? 0
}

/** Unsubscribe all feeds + clear all state for a coin. */
async function unsubscribeCoin(coin: string): Promise<void> {
  await unsubscribeCandles(coin)
  if (getActiveExchange() === 'HL') {
    await unsubscribeTrades(coin)
    await unsubscribeOrderBook(coin)
    removeFundingCoin(coin)
    removeOiCoin(coin)
  } else if (getActiveExchange() === 'BB') {
    unsubscribeBybitTrades(coin)
    unsubscribeBybitTicker(coin)
  }
  clearCoinData(coin)
  clearCoinState(coin)
}

// ── CoinSelector + onRefresh ────────────────────────────────────────────────

async function onCoinsRefreshed(result: RefreshResult): Promise<void> {
  // Subscribe + backfill new coins
  for (const coin of result.added) {
    log.info('lifecycle', `COIN-ADD | ${coin} — subscribing + backfilling`)
    await subscribeCoin(coin)
    await backfillCoin(coin)
    bootstrapPipelineFromStore([coin])
    if (getActiveExchange() === 'HL') {
      await addFundingCoin(coin)
      addOiCoin(coin)
    }
  }

  // Unsubscribe dropped coins (no active setup — already filtered by CoinSelector)
  for (const coin of result.dropped) {
    log.info('lifecycle', `COIN-DROP | ${coin} — unsubscribing + clearing`)
    await unsubscribeCoin(coin)
  }
}

// Module-level selector — initialized in main() with exchange-aware fetch fn, used by cleanup()
let selector: CoinSelector

// ── Main ─────────────────────────────────────────────────────────────────────

// Track intervals so we can clear them before reconnect
const activeIntervals: ReturnType<typeof setInterval>[] = []

/** TUI live Account: closed-trade stats for the shared runtime wallet (refreshed from DB). */
let liveWalletStatsCache: LiveWalletStats | null = null

/** TUI live: last cached account states for the shared runtime wallet. */
let liveAccountStatesCache: Map<string, AccountState> | null = null

/**
 * TUI live: last HL clearinghouse snapshot (refreshed ~10s). {@link PositionMonitor} is merged
 * synchronously on each TUI read so bot-opened positions appear immediately — caching the merged
 * Map caused empty maps to mask fresh tracked positions until the next refresh.
 */
let liveTuiExchangePositionsCache: ExchangePositionSnapshot[] | null = null

class StartupFatalError extends Error {}

async function refreshLiveWalletStatsCache(): Promise<void> {
  try {
    const rows = await getClosedTradeStatsForWallet()
    liveWalletStatsCache = buildLiveWalletStats(rows)
  } catch {
    // Transient DB errors: keep previous cache
  }
}

function aggregateAccountStatesForTui(m: Map<string, AccountState>): AccountState {
  if (m.size === 0) {
    throw new Error('aggregateAccountStatesForTui: empty map')
  }
  let accountValue = 0
  let totalNtlPos = 0
  let totalMarginUsed = 0
  let withdrawable = 0
  let spotUsdcBalance = 0
  let effectiveBalance = 0
  for (const st of m.values()) {
    accountValue += st.accountValue
    totalNtlPos += st.totalNtlPos
    totalMarginUsed += st.totalMarginUsed
    withdrawable += st.withdrawable
    spotUsdcBalance += st.spotUsdcBalance
    effectiveBalance += st.effectiveBalance
  }
  return {
    accountValue,
    totalNtlPos,
    totalMarginUsed,
    withdrawable,
    spotUsdcBalance,
    effectiveBalance,
  }
}

async function refreshLiveAccountStatesForTui(): Promise<void> {
  try {
    const pool = getExchangePool()
    if (!pool.isInitialized()) return

    // Single shared account: leave cache null so Account panel uses the shared account state directly.
    liveAccountStatesCache = null
  } catch {
    // Keep previous cache on HL errors
  }
}

function refreshLiveTuiPositionsCache(): void {
  // Reuse cached snapshots from position-monitor's syncWithExchange — avoids duplicate API calls.
  liveTuiExchangePositionsCache = getPositionMonitor().getLastExchangeSnapshots()
}

async function refreshLiveTuiCaches(): Promise<void> {
  await refreshLiveWalletStatsCache()
  await refreshLiveAccountStatesForTui()
  await refreshLiveTuiPositionsCache()
}

async function main(): Promise<void> {
  const activeExchange = getActiveExchange()
  feed = activeExchange === 'HL' ? new HLFeed() : new BybitFeed()
  dashboardBootstrapPhase = 'warming_up'

  // Initialize selector with exchange-aware fetch function and top-coin limit.
  // BB: dynamic fetch from Bybit tickers API (top 50 by OI), no HIP-3.
  // HL: default behavior (fetchRankedCoins from HL API + HIP-3, top 20).
  const fetchRankedFn = activeExchange === 'BB' ? makeBybitFetchRankedFn() : undefined
  const topLimit = activeExchange === 'BB' ? BYBIT_TOP_COINS_LIMIT : undefined
  selector = createCoinSelector(getActiveSetupCoins, onCoinsRefreshed, fetchRankedFn, topLimit)

  // Banner — logged before TUI starts, so these safely go to console
  const modeTag = process.env['BYBIT_DEMO'] === 'true' ? 'DEMO' : 'LIVE'
  log.info('startup', `Minh (明) v2.0.0 — Autonomous Trading Agent [${modeTag}]`)
  log.info('startup',
    `Config: dynamic top coins × ${TIMEFRAMES.join(',')} | ` +
    `min:${MIN_CONFIDENCE} | confluence:${CONFLUENCE_MIN}+ | ` +
    `regime:${REGIME_MULTIPLIERS.aligned}/${REGIME_MULTIPLIERS.neutral}/${REGIME_MULTIPLIERS.counter}`,
  )

  // 0a. Validate window policies before anything loads data
  validateWindowPolicies()

  // 0b. Log window policy summary
  const fmtPolicy = (p: Record<string, number>) =>
    TIMEFRAMES.map(tf => `${tf}:${p[tf]}`).join(' ')
  log.info('startup', `Window policy | bootstrap: ${fmtPolicy(BOOTSTRAP_LOAD_BARS)}`)
  log.info('startup', `Window policy | hot_cache:  ${fmtPolicy(HOT_CACHE_CAP_BARS)}`)
  log.info('startup', `Window policy | planning:   ${fmtPolicy(PLANNING_WINDOW_BARS)}`)
  log.info('startup', `Window policy | replay:     ${fmtPolicy(STATE_REPLAY_BARS)}`)
  log.info('startup', `Window policy | ready:      ${fmtPolicy(READY_BARS)}`)

  // 0c. Run DB migrations
  await runMigrations(sql)

  // 1. Fetch top coins from HL — fatal if empty at startup (spec requirement)
  //    skipCallback=true: main() handles initial subscribe+backfill in batch (efficient)
  //    onCoinsRefreshed is only for mid-run coin additions/removals
  const initialResult = await selector.refresh(true)
  let coins = selector.getTrackedCoins()

  if (coins.length === 0) {
    throw new Error('fetchTopCoins returned empty at startup — cannot proceed without coin list')
  }

  const hip3Count = selector.getHip3Coins().length
  const nativeCount = coins.length - hip3Count
  log.info('startup', `COINS | ${coins.length} coins selected (${nativeCount} native + ${hip3Count} HIP-3)`)

  // 1b. Probe all coins with a quick 1m candle fetch — drop unavailable coins early.
  //     Skip for BB: probeCoins uses HL REST; static Bybit coins are well-known and don't need probing.
  if (activeExchange === 'HL') {
    const { valid: validCoins, failed: probeFailed } = await probeCoins(coins)
    if (probeFailed.length > 0) {
      const replacements = selector.replaceFailed(probeFailed)
      if (replacements.length > 0) {
        // Probe replacements too
        const { valid: replValid, failed: replFailed } = await probeCoins(replacements)
        if (replFailed.length > 0) {
          selector.replaceFailed(replFailed)
        }
        validCoins.push(...replValid)
      }
      coins = selector.getTrackedCoins()
      log.info('startup', `COINS | after probe: ${coins.length} coins (${probeFailed.length} replaced)`)
    }
  }

  // 2. WS subscribe FIRST — capture real-time candles immediately
  //    Enable bootstrap ingress mode: WS candles go to buffer, not full pipeline.
  wsBuffer = []
  for (const coin of coins) {
    await subscribeCoin(coin)
  }

  // 2b. Start TUI immediately — shows backfill progress (transitions to dashboard when done)
  const tuiSources: TuiDataSources = {
    getAgentSnapshot: () => ({
      global: { dailyPnl: 0, totalConsecutiveLosses: 0, globalPaused: false, globalPauseReason: null, uptime: 0 },
      coins: {},
    }),
    getPositions: () => new Map(),
    getStatus: () => getStatus(),
    getHealthReport: () => ({
      overall: 'ok', uptime: 0, rssBytes: process.memoryUsage().rss,
      components: {
        feed: { status: 'ok', consecutiveErrors: 0 },
        db: { status: 'ok', consecutiveErrors: 0 },
        exchange: { status: 'ok', consecutiveErrors: 0 },
      },
    }),
    getAccountState: () => null,
    getSubscriptionCount,
    getTrackedCoins: () => selector.getTrackedCoins(),
    getAssetPrice: (coin: string) => {
      if (activeExchange === 'BB') {
        // BB has no separate mark-price feed — use last 1m candle close as price proxy.
        const candles = getCandles(coin, '1m', 1)
        if (candles.length === 0) return null
        const last = candles[candles.length - 1]!
        return {
          markPrice: last.c,
          funding: getBybitFundingRate(coin),
          dayChangePctUtc: dayChangePctFromUtcDayOpen(coin, last.c),
        }
      }
      const ctx = getLatestAssetCtx(coin)
      if (!ctx) return null
      return {
        markPrice: ctx.markPrice,
        funding: ctx.funding,
        dayChangePctUtc: dayChangePctFromUtcDayOpen(coin, ctx.markPrice),
      }
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
  }
  tuiLogStream = createWriteStream('./minh.log', { flags: 'a' })
  setTuiSink(msg => { tuiLogStream!.write(msg + '\n') })
  startTui(tuiSources)
  try {
    startDashboardServer({
      activeExchange,
      getBootstrapPhase: () => dashboardBootstrapPhase,
      sources: tuiSources,
    })
  } catch (err) {
    log.warn('dashboard', `Dashboard startup failed (non-fatal): ${err instanceof Error ? err.message : err}`)
  }

  // 3. Load candles from PG → memory
  const pgTimestamps = await getAllLastTimestamps()
  const now = Date.now()
  let pgLoadedTotal = 0

  for (const coin of coins) {
    for (const tf of TIMEFRAMES) {
      const interval = tf as CandleInterval
      const storeKey = `${coin}|${interval}`
      const lastPgTs = pgTimestamps.get(storeKey) ?? null
      const fullCount = BACKFILL_CANDLE_COUNTS[interval] ?? BACKFILL_CANDLE_COUNT

      if (lastPgTs !== null) {
        const pgCandles = await loadCandles(coin, interval, fullCount)
        if (pgCandles.length > 0) {
          setCandles(coin, interval, pgCandles)
          pgLoadedTotal += pgCandles.length
        }
      }
    }
  }

  if (pgLoadedTotal > 0) {
    log.info('startup', `PG load: ${pgLoadedTotal} candles`)
  }

  // 4. Gap-fill + full backfill via REST (batched, skips coin/TFs already sufficient)
  const backfillResults = await feed.backfill(
    coins,
    (coin, interval, candles) => {
      setCandles(coin, interval, candles)
      bulkUpsertCandles(coin, interval, candles).catch(err => {
        log.error('persist', `bulk upsert failed ${coin}|${interval}: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
    (coin, interval) => candleCount(coin, interval) >= (READY_BARS[interval as CandleInterval] ?? MIN_CANDLES_FOR_SCAN),
  )
  const tfReady = new Map<string, number>()
  for (const r of backfillResults) tfReady.set(r.coin, r.readyTFs)

  // 4b. Replace coins that completely failed backfill (0 readyTFs)
  //     Pull next-ranked candidates from the full HL list, up to BACKFILL_REPLACEMENT_ROUNDS
  const allFailed = new Set<string>()
  for (let round = 1; round <= BACKFILL_REPLACEMENT_ROUNDS; round++) {
    const failedThisRound = coins.filter(c => (tfReady.get(c) ?? 0) === 0 && !allFailed.has(c))
    if (failedThisRound.length === 0) break

    for (const fc of failedThisRound) allFailed.add(fc)
    log.info('lifecycle', `COIN-REPLACE | round ${round}: removing ${failedThisRound.join(', ')} (0 readyTFs)`)

    // Unsubscribe failed coins (already subscribed in step 3)
    for (const fc of failedThisRound) {
      await unsubscribeCoin(fc)
    }

    // Get replacements from ranked list
    const replacements = selector.replaceFailed(failedThisRound)
    if (replacements.length === 0) {
      log.info('lifecycle', `COIN-REPLACE | no more candidates available`)
      break
    }

    log.info('lifecycle', `COIN-REPLACE | adding ${replacements.join(', ')}`)

    // Subscribe + backfill replacements
    for (const rc of replacements) {
      await subscribeCoin(rc)
    }
    const replResults = await feed.backfill(replacements, (coin, interval, candles) => {
      setCandles(coin, interval, candles)
      bulkUpsertCandles(coin, interval, candles).catch(err => {
        log.error('persist', `bulk upsert failed ${coin}|${interval}: ${err instanceof Error ? err.message : String(err)}`)
      })
    })
    for (const r of replResults) tfReady.set(r.coin, r.readyTFs)

    // Update coins list for subsequent steps
    coins = selector.getTrackedCoins()
  }

  if (allFailed.size > 0) {
    log.info('lifecycle', `COIN-REPLACE | done — replaced ${allFailed.size} failed coins | now tracking ${coins.length}`)
  }

  // 4c. Bootstrap replay: rebuild multi-stage strategy state from historical candles
  //     snapshot → clear → preseed → global chronological replay → flush WS buffer → materialize
  const replayCount = bootstrapReplayFromStore(coins)
  if (replayCount > 0) {
    log.info('startup', `Replay hydrate: ${replayCount} candles replayed`)
  }

  // 4d. Flush WS buffer: feed buffered live candles through the full pipeline
  const buffered = wsBuffer ?? []
  wsBuffer = null  // disable buffer — WS candles now go direct to onCandleTick
  if (buffered.length > 0) {
    for (const ev of buffered) {
      onCandleTick(ev.coin, ev.interval, ev.candle)
    }
    log.info('startup', `WS buffer flushed: ${buffered.length} candles`)
  }

  // 4e. Signal TUI: backfill complete → transition to dashboard
  //     NOTE: materialize current setups happens later (step 9b) after agent subscribes to pipeline.
  setBackfillDone()
  dashboardBootstrapPhase = 'ready'

  // 5. Wire PG write-through for live WS candles (R14: sync write-through)
  //    Wired AFTER backfill so startup uses efficient bulk operations, not per-candle upserts
  //    S13: record health on success/error
  const health = getHealthMonitor()
  setOnPersist((coin, interval, candle) => {
    health.recordSuccess('feed')
    upsertCandle(coin, interval, candle)
      .then(() => health.recordSuccess('db'))
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        log.error('persist', `upsert failed ${coin}|${interval} t=${candle.t}: ${msg}`)
        health.recordError('db', msg)
      })
  })

  // 6. Start funding + OI polling — HL only (asset-ctx + funding use HL WS/REST)
  if (activeExchange === 'HL') {
    await Promise.all([startFundingPolling(coins), startOiFeed(coins)])
  } else if (activeExchange === 'BB') {
    // Load Bybit funding rates once (public endpoint, no auth).
    // Funding settles every 8h — refresh every 4h is sufficient.
    await loadBybitFundingRates()
    activeIntervals.push(setInterval(() => void loadBybitFundingRates(), BYBIT_FUNDING_REFRESH_MS))
  }

  // 7. ARMED readiness gate
  const fullyReady = coins.filter(c => (tfReady.get(c) ?? 0) === TIMEFRAMES.length).length
  const partialReady = coins.filter(c => {
    const r = tfReady.get(c) ?? 0
    return r > 0 && r < TIMEFRAMES.length
  }).length
  log.info('startup', `ARMED | ${coins.length} coins: ${fullyReady} fully ready, ${partialReady} partial | ${TIMEFRAMES.length} TFs`)

  // 7b. Single concrete setup generator
  resetSetupGenerator()
  log.info('startup', 'STRAT | canonical single-strategy scanner: smc-sd')

  // 7c. Init ExchangePool (single shared exchange wallet/service per process)
  const pool = getExchangePool()
  try {
    await pool.init()
    const svc = pool.getShared()
    const account = await svc.getAccountState()
    let positions: ExchangePositionSnapshot[] = []
    try {
      positions = await svc.getPositions()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('startup', `POS   | Could not fetch open positions: ${msg}`)
    }
    const acctAddr = svc.getAccountAddress()
    const addrShort = `${acctAddr.slice(0, 6)}…${acctAddr.slice(-4)}`

    const exchangeName = activeExchange === 'BB' ? 'Bybit' : 'Hyperliquid'
    log.info('startup', `MODE  | LIVE TRADING — real orders on ${exchangeName}`)
    log.info('startup', `ACCT  | ${addrShort} | balance: $${account.effectiveBalance.toFixed(2)} (perp: $${account.accountValue.toFixed(2)} + spot: $${account.spotUsdcBalance.toFixed(2)}) | margin: $${account.totalMarginUsed.toFixed(2)} | free: $${account.withdrawable.toFixed(2)}`)

    if (positions.length > 0) {
      const posLines = positions.map(p => {
        const side = p.size > 0 ? 'LONG' : 'SHORT'
        const pnlSign = p.unrealizedPnl >= 0 ? '+' : ''
        return `  ${p.coin.padEnd(10)} ${side} ${Math.abs(p.size)} @ $${p.entryPrice.toFixed(2)} | uPnL: ${pnlSign}$${p.unrealizedPnl.toFixed(2)}${p.liquidationPrice ? ` | liq: $${p.liquidationPrice.toFixed(2)}` : ''}`
      }).join('\n')
      log.info('startup', `POS   | ${positions.length} open position(s):\n${posLines}`)
    } else {
      log.info('startup', 'POS   | no open positions')
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : typeof err === 'object' ? JSON.stringify(err) : String(err)
    if (!pool.isInitialized()) {
      log.error('startup', `FATAL | Exchange pool init failed: ${msg}`)
      throw new StartupFatalError(`Exchange pool init failed: ${msg}`)
    }
    // Pool initialized but account query failed — non-fatal, continue with degraded state.
    // Common on Bybit Demo Trading when account has no balance yet.
    log.warn('startup', `ACCT  | Could not fetch account info (non-fatal): ${msg}`)
  }

  // 8. Start health monitor periodic check (S13: Self-Healing)
  health.startPeriodicCheck()

  // 9. Wire agent components for the single-runtime execution loop
  const agent = getAgent()
  const om = getOrderManager()
  const pm = getPositionMonitor()
  const bridge = getInvalidationBridge()

  if (pool.isInitialized()) {
    om.setExchangePool(pool)
  }

  // Load active orders from DB (crash recovery R1)
  await om.loadActiveOrders()

  // Agent → OrderManager (bidirectional).
  // MUST be wired BEFORE subscribeToPipeline + bootstrapPipelineFromStore so that
  // place_order actions emitted during bootstrap are handled (not lost).
  agent.onAction(action => om.handleAction(action))
  om.setAgentDispatch((coin, event) => agent.dispatch(coin, event))

  // OrderManager → PositionMonitor: register position on fill (enables TUI display + trail stop)
  om.setPositionOpenCallback(params => pm.openPosition(params))

  // Crash recovery: re-register positions from DB-filled orders for coins still open on exchange.
  // PositionMonitor state is in-memory — lost on restart → positions show as 'ext' without this.
  try {
    const openSnaps = await queryExchangePositions()
    if (openSnaps) om.restoreOpenPositions(openSnaps)
  } catch (err) {
    log.warn('agent', `restoreOpenPositions failed (non-fatal): ${err instanceof Error ? err.message : err}`)
  }

  // Agent → PositionMonitor (dispatch back, keyed by coin only)
  pm.setAgentDispatch((coin, event) => agent.dispatch(coin, event))

  // PositionMonitor → OrderManager: trail stop SL updates go directly to exchange
  pm.setUpdateStopCallback((parentOrderId, newSlPrice) => om.modifySLPrice(parentOrderId, newSlPrice))

  // Wire equity updates from PositionMonitor back into the agent for portfolio risk checks.
  pm.setEquityCallback(equity => agent.setAccountEquity(equity))

  // Start exchange sync heartbeat (R3: 10s interval)
  pm.startSync()

  // Order fill timeout watchdog: release stuck ENTERING states when limit orders never fill.
  // ORDER_FILL_TIMEOUT_MS = 5 min; check every 60s is sufficient.
  activeIntervals.push(setInterval(() => void om.checkTimeouts(), 60_000))

  // Wire metrics service: refresh matviews after each trade close
  connectMetrics(agent)

  // Telegram trade alerts (HTML) — fire-and-forget
  // MUST be wired BEFORE bootstrapPipelineFromStore so bootstrap signals reach Telegram.
  agent.onAction(action => {
    const msg = formatAlert(action)
    if (msg) void sendTelegramAlert(msg.text, globalThis.fetch, { parseMode: msg.parseMode })
  })

  // Start Telegram bot (long-polling command interface)
  await startBot()

  // Agent ← Pipeline (setup events)
  // Subscribed AFTER all agent.onAction handlers are wired so bootstrap actions are not lost.
  agent.subscribeToPipeline(getPipelineEmitter())

  // InvalidationBridge ← Pipeline (invalidation events) → Agent
  bridge.connect(getPipelineEmitter(), agent)

  // 9b. Materialize current-bar setups + seed WS dedup (AFTER agent subscribes to pipeline)
  //     If replay ran, state is already rebuilt — materialize emits current setups to agent.
  //     If no replay (STATE_REPLAY_BARS all 0), falls back to bootstrapPipelineFromStore.
  if (replayCount > 0) {
    materializeCurrentSetupsFromStore(coins)
  } else {
    bootstrapPipelineFromStore(coins)
  }

  log.info('agent', 'Agent wired: smc-sd + exchange pool + order manager + position monitor + invalidation bridge + Telegram bot')

  // 10. Start coin refresh loop
  selector.startRefreshLoop()

  // 11. Upgrade TUI data sources — agent + health now initialized
  tuiSources.getAgentSnapshot = () => agent.getSnapshot()
  tuiSources.getPositions = () => {
    const exchangeSnap = liveTuiExchangePositionsCache
    if (exchangeSnap === null) return pm.getPositions()
    return mergeExchangeAndTrackedForTui(pm.getPositions(), exchangeSnap)
  }
  tuiSources.getHealthReport = () => health.getReport()
  tuiSources.getAccountState = async () => {
    try {
      if (liveAccountStatesCache && liveAccountStatesCache.size > 0) {
        const p = getExchangePool()
        if (!p.isInitialized()) return null
        return aggregateAccountStatesForTui(liveAccountStatesCache)
      }
      // Reuse cached state from position-monitor's syncWithExchange — avoids duplicate API calls.
      return pm.getLastAccountState()
    } catch {
      return null
    }
  }
  tuiSources.getLiveAccountStates = () => liveAccountStatesCache
  tuiSources.getInvalidationStats = () => getInvalidationBridge().getStats()

  void refreshLiveTuiCaches()
  activeIntervals.push(setInterval(() => void refreshLiveTuiCaches(), 10_000))

  // 12. Staleness watchdog (candles + order book — book only on HL)
  activeIntervals.push(setInterval(() => {
    feed.checkStaleness()
    if (activeExchange === 'HL') checkBookStaleness()
  }, STALENESS_CHECK_INTERVAL_MS))

  // Keep alive — resolve when WS dies (detected via staleness or thrown error)
  await new Promise(() => {
    // intentionally never resolves — process stays alive via setIntervals
  })
}

/** Clean up intervals, WS connections, refresh loop, polling, agent sync, and TUI before reconnect/shutdown. */
async function cleanup(reason: 'reconnect' | 'shutdown' = 'reconnect'): Promise<void> {
  dashboardBootstrapPhase = 'warming_up'
  stopDashboardServer()
  clearTuiSink()
  tuiLogStream?.end()
  tuiLogStream = null
  stopTui()
  selector.stopRefreshLoop()
  getPositionMonitor().stopSync()
  stopBot()
  for (const id of activeIntervals) clearInterval(id)
  activeIntervals.length = 0
  stopFundingPolling()
  await stopOiFeed()
  await feed.closeAll()
  if (getActiveExchange() === 'BB') {
    if (reason === 'shutdown') {
      try {
        const pool = getExchangePool()
        if (pool.isInitialized()) {
          const svc = pool.getShared() as ShutdownSafeExchange
          if (typeof svc.cancelAllOpenOrders === 'function') {
            const result = await svc.cancelAllOpenOrders()
            if (!result.success) {
              log.error('shutdown', `Bybit cancel-all-on-exit failed: ${result.error}`)
            }
          }
        }
      } catch (err) {
        log.error('shutdown', `Bybit cancel-all-on-exit exception: ${err instanceof Error ? err.message : err}`)
      }
    }
    closeAllBybitTrades()
    closeAllBybitTicker()
  }
  resetSetupGenerator()
}

/** Run the runtime with exponential backoff reconnection on failure. */
export async function runRuntime(): Promise<never> {
  let delay = WS_RECONNECT_INITIAL_MS
  let shuttingDown = false

  const handleShutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutdown', `Received ${signal}; closing connections...`)
    getHealthMonitor().stopPeriodicCheck()
    getPositionMonitor().stopSync()
    await cleanup('shutdown')
    await closeDb()
    log.info('shutdown', 'Minh stopped gracefully.')
    process.exit(0)
  }

  // Shutdown handlers — register once, outside retry loop
  process.on('SIGINT', () => { void handleShutdown('SIGINT') })
  process.on('SIGTERM', () => { void handleShutdown('SIGTERM') })

  while (true) {
    try {
      await main()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (err instanceof StartupFatalError) {
        log.error('lifecycle', `STARTUP FATAL | ${msg}`)
        try {
          await cleanup()
        } catch {
          // best-effort cleanup before process exit
        }
        throw err
      }
      log.error('lifecycle', `CONNECTION LOST | ${msg}`)
      log.info('lifecycle', `RECONNECT | retrying in ${Math.round(delay / 1000)}s...`)

      // Tear down everything before retry
      await cleanup()

      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(delay * WS_RECONNECT_BACKOFF, WS_RECONNECT_MAX_MS)

      log.info('lifecycle', 'RECONNECT | restarting subscriptions + backfill...')
    }
  }
}
