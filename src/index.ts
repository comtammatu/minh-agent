/**
 * Minh (明) — entry point.
 *
 * Startup sequence:
 *   0. Run DB migrations
 *   1. CoinSelector: fetch top coins from HL by OI
 *   2. Load candles from PG → memory, gap-fill missing via REST
 *   3. WS subscribe all coins (candles × 6 TFs + trades + order book)
 *   4. REST backfill remaining (coins not in PG get full backfill)
 *   5. Wire PG write-through for live WS candles
 *   6. Start funding + OI polling
 *   7. Print ARMED + coin counts
 *   8. Start health monitor
 *   9. Wire agent: TradingAgent ↔ OrderManager ↔ PositionMonitor + InvalidationBridge
 *  10. Start coin refresh loop (1h interval)
 *  11. setInterval: STATUS line every 60s
 *  12. setInterval: staleness check every 30s
 *  SIGINT: stop sync → close WS → close DB → exit
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
  PAPER_TRADE,
  MIN_CANDLES_FOR_SCAN,
} from './config.js'
import { backfillAllCoins, fetchCandles, probeCoins } from './feed/rest.js'
import { setCandles, clearCoinData, setOnPersist, appendCandle, candleCount } from './feed/store.js'
import { subscribeCandles, unsubscribeCandles, closeAll, checkStaleness, getSubscriptionCount } from './feed/ws.js'
import { startFundingPolling, stopFundingPolling, addFundingCoin, removeFundingCoin } from './feed/funding.js'
import { startOiFeed, stopOiFeed, addOiCoin, removeOiCoin } from './feed/asset-ctx.js'
import { subscribeTrades, unsubscribeTrades } from './feed/trades.js'
import { subscribeOrderBook, unsubscribeOrderBook, checkBookStaleness } from './feed/orderbook.js'
import { createCoinSelector } from './feed/coin-selector.js'
import type { RefreshResult } from './feed/coin-selector.js'
import { onCandleTick, getStatus, getActiveSetupCoins, clearCoinState } from './scanner/pipeline.js'
import { sql, closeDb } from './db/connection.js'
import { runMigrations } from './db/migrate.js'
import {
  upsertCandle,
  bulkUpsertCandles,
  getAllLastTimestamps,
  loadCandles,
  computeGapStart,
  shouldGapFill,
} from './db/candle-repo.js'
import { log } from './lib/logger.js'
import { getHealthMonitor } from './agent/self-healing.js'
import { ANSI } from './ui/terminal.js'
import { startTui, stopTui, appendSignal, appendLog } from './ui/tui.jsx'
import { getPipelineEmitter } from './scanner/pipeline.js'
import { getAgent } from './agent/trading-agent.js'
import { getOrderManager } from './agent/order-manager.js'
import { getPositionMonitor } from './agent/position-monitor.js'
import { getInvalidationBridge } from './agent/invalidation-bridge.js'
import { startBot, stopBot } from './alert/telegram/index.js'
import { connectToAgent as connectMetrics } from './analytics/metrics-service.js'
import { getExchangePool } from './execution/exchange-pool.js'
import { getStrategyRegistry } from './scanner/strategy.js'
import { LayeredStrategyAdapter } from './scanner/strategies/layered-adapter.js'
import { QuantStrategyAdapter } from './scanner/strategies/quant-adapter.js'
import { SmcSdStrategy } from './scanner/strategies/smc-sd.js'
import type { CandleInterval } from './types.js'

// ── Banner ───────────────────────────────────────────────────────────────────

const modeTag = PAPER_TRADE
  ? `${ANSI.bold}${ANSI.yellow}PAPER${ANSI.reset}`
  : `${ANSI.bold}${ANSI.red}LIVE${ANSI.reset}`
console.log(`[${ts()}] ${ANSI.bold}${ANSI.cyan}Minh (明) v2.0.0${ANSI.reset} — Autonomous Trading Agent [${modeTag}]`)
console.log(
  `[${ts()}] Config: dynamic top coins × ${TIMEFRAMES.join(',')} | ` +
  `min:${MIN_CONFIDENCE} | confluence:${CONFLUENCE_MIN}+ | ` +
  `regime:${REGIME_MULTIPLIERS.aligned}/${REGIME_MULTIPLIERS.neutral}/${REGIME_MULTIPLIERS.counter}`,
)

// ── Coin Lifecycle Helpers ──────────────────────────────────────────────────

/** Subscribe all WS feeds for a coin (candles × TFs + trades + orderbook). */
async function subscribeCoin(coin: string): Promise<void> {
  for (const tf of TIMEFRAMES) {
    await subscribeCandles(coin, tf as CandleInterval, onCandleTick)
  }
  await subscribeTrades(coin)
  await subscribeOrderBook(coin)
}

/** Backfill a single coin (used during mid-run coin additions). */
async function backfillCoin(coin: string): Promise<number> {
  const results = await backfillAllCoins([coin], (c, interval, candles) => {
    setCandles(c, interval, candles)
  })
  return results[0]?.readyTFs ?? 0
}

/** Unsubscribe all feeds + clear all state for a coin. */
async function unsubscribeCoin(coin: string): Promise<void> {
  await unsubscribeCandles(coin)
  await unsubscribeTrades(coin)
  await unsubscribeOrderBook(coin)
  removeFundingCoin(coin)
  removeOiCoin(coin)
  clearCoinData(coin)
  clearCoinState(coin)
}

// ── CoinSelector + onRefresh ────────────────────────────────────────────────

async function onCoinsRefreshed(result: RefreshResult): Promise<void> {
  // Subscribe + backfill new coins
  for (const coin of result.added) {
    console.log(`[${ts()}] COIN-ADD | ${coin} — subscribing + backfilling`)
    await subscribeCoin(coin)
    await backfillCoin(coin)
    await addFundingCoin(coin)
    addOiCoin(coin)
  }

  // Unsubscribe dropped coins (no active setup — already filtered by CoinSelector)
  for (const coin of result.dropped) {
    console.log(`[${ts()}] COIN-DROP | ${coin} — unsubscribing + clearing`)
    await unsubscribeCoin(coin)
  }
}

// Module-level selector — accessible from cleanup()
const selector = createCoinSelector(getActiveSetupCoins, onCoinsRefreshed)

// ── Main ─────────────────────────────────────────────────────────────────────

// Track intervals so we can clear them before reconnect
const activeIntervals: ReturnType<typeof setInterval>[] = []

async function main(): Promise<void> {
  // 0. Run DB migrations
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
  console.log(`[${ts()}] COINS | ${coins.length} coins selected (${nativeCount} native + ${hip3Count} HIP-3)`)

  // 1b. Probe all coins with a quick 1m candle fetch — drop unavailable coins early
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
    const newHip3 = selector.getHip3Coins().length
    console.log(`[${ts()}] COINS | after probe: ${coins.length} coins (${probeFailed.length} replaced)`)
  }

  // 2. Load candles from PG → memory, then gap-fill missing candles via REST
  const pgTimestamps = await getAllLastTimestamps()
  const now = Date.now()
  let pgLoadedTotal = 0
  let gapFillTotal = 0

  for (const coin of coins) {
    for (const tf of TIMEFRAMES) {
      const interval = tf as CandleInterval
      const storeKey = `${coin}|${interval}`
      const lastPgTs = pgTimestamps.get(storeKey) ?? null
      const intervalMs = TIMEFRAME_MS[interval]
      const fullCount = BACKFILL_CANDLE_COUNTS[interval] ?? BACKFILL_CANDLE_COUNT

      if (shouldGapFill(lastPgTs, now, intervalMs, fullCount)) {
        // Load existing candles from PG into memory
        const pgCandles = await loadCandles(coin, interval, fullCount)
        if (pgCandles.length > 0) {
          setCandles(coin, interval, pgCandles)
          pgLoadedTotal += pgCandles.length
        }

        // Gap-fill: fetch only missing candles from REST
        const gapStart = computeGapStart(lastPgTs, intervalMs)!
        const gapCandles = await fetchCandles(coin, interval, gapStart, now)
        if (gapCandles && gapCandles.length > 0) {
          // Persist gap-fill candles to PG
          await bulkUpsertCandles(coin, interval, gapCandles)
          // Merge into in-memory store (setCandles would overwrite, so append each)
          for (const c of gapCandles) {
            appendCandle(coin, interval, c)
          }
          gapFillTotal += gapCandles.length
        }
      }
      // else: no PG data → will do full REST backfill below
    }
  }

  if (pgLoadedTotal > 0 || gapFillTotal > 0) {
    log.info('startup', `PG load: ${pgLoadedTotal} candles | Gap-fill: ${gapFillTotal} candles`)
  }

  // 3. Subscribe all coins (WS first, before backfill — captures candles during backfill)
  for (const coin of coins) {
    await subscribeCoin(coin)
  }

  // 4. REST backfill all coins — skips coin/TFs already loaded from PG gap-fill
  const backfillResults = await backfillAllCoins(
    coins,
    (coin, interval, candles) => {
      setCandles(coin, interval, candles)
      // Persist backfilled candles to PG
      bulkUpsertCandles(coin, interval, candles).catch(err => {
        log.error('persist', `bulk upsert failed ${coin}|${interval}: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
    undefined, // concurrency — use default
    // Skip coin/TFs that already have enough candles from PG gap-fill (step 2)
    (coin, interval) => candleCount(coin, interval) >= MIN_CANDLES_FOR_SCAN,
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
    console.log(`[${ts()}] COIN-REPLACE | round ${round}: removing ${failedThisRound.join(', ')} (0 readyTFs)`)

    // Unsubscribe failed coins (already subscribed in step 3)
    for (const fc of failedThisRound) {
      await unsubscribeCoin(fc)
    }

    // Get replacements from ranked list
    const replacements = selector.replaceFailed(failedThisRound)
    if (replacements.length === 0) {
      console.log(`[${ts()}] COIN-REPLACE | no more candidates available`)
      break
    }

    console.log(`[${ts()}] COIN-REPLACE | adding ${replacements.join(', ')}`)

    // Subscribe + backfill replacements
    for (const rc of replacements) {
      await subscribeCoin(rc)
    }
    const replResults = await backfillAllCoins(replacements, (coin, interval, candles) => {
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
    console.log(`[${ts()}] COIN-REPLACE | done — replaced ${allFailed.size} failed coins | now tracking ${coins.length}`)
  }

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

  // 6. Start funding + OI polling for all coins (independent — run in parallel)
  await Promise.all([startFundingPolling(coins), startOiFeed(coins)])

  // 7. ARMED readiness gate
  const fullyReady = coins.filter(c => (tfReady.get(c) ?? 0) === TIMEFRAMES.length).length
  const partialReady = coins.filter(c => {
    const r = tfReady.get(c) ?? 0
    return r > 0 && r < TIMEFRAMES.length
  }).length
  console.log(
    `[${ts()}] ${ANSI.bold}${ANSI.green}ARMED${ANSI.reset} | ${coins.length} coins: ${fullyReady} fully ready, ${partialReady} partial | ${TIMEFRAMES.length} TFs`,
  )

  // 7b. Register strategies (Sprint 4.5: multi-strategy fan-out)
  const registry = getStrategyRegistry()
  registry.register(new LayeredStrategyAdapter())
  registry.register(new QuantStrategyAdapter())
  registry.register(new SmcSdStrategy())
  const strategyIds = registry.getAll().map(s => s.id)
  console.log(`[${ts()}] ${ANSI.dim}STRAT${ANSI.reset} | ${strategyIds.length} strategies registered: ${strategyIds.join(', ')}`)

  // 7c. Init ExchangePool (Sprint 4.5: per-strategy wallets or shared fallback)
  const pool = getExchangePool()
  try {
    await pool.init()
    const svc = pool.getShared()
    const account = await svc.getAccountState()
    const positions = await svc.getPositions()
    const acctAddr = svc.getAccountAddress()
    const addrShort = `${acctAddr.slice(0, 6)}…${acctAddr.slice(-4)}`

    if (PAPER_TRADE) {
      console.log(
        `[${ts()}] ${ANSI.bold}${ANSI.yellow}MODE${ANSI.reset}  | PAPER TRADE — orders are SIMULATED, no real exchange calls`,
      )
    } else {
      console.log(
        `[${ts()}] ${ANSI.bold}${ANSI.red}MODE${ANSI.reset}  | LIVE TRADING — real orders on Hyperliquid`,
      )
    }
    console.log(
      `[${ts()}] ${ANSI.dim}ACCT${ANSI.reset}  | ${addrShort} | balance: $${account.effectiveBalance.toFixed(2)} (perp: $${account.accountValue.toFixed(2)} + spot: $${account.spotUsdcBalance.toFixed(2)}) | margin: $${account.totalMarginUsed.toFixed(2)} | free: $${account.withdrawable.toFixed(2)}`,
    )

    if (positions.length > 0) {
      console.log(`[${ts()}] ${ANSI.dim}POS${ANSI.reset}   | ${positions.length} open position(s):`)
      for (const p of positions) {
        const side = p.size > 0 ? `${ANSI.green}LONG${ANSI.reset}` : `${ANSI.red}SHORT${ANSI.reset}`
        const pnlColor = p.unrealizedPnl >= 0 ? ANSI.green : ANSI.red
        console.log(
          `[${ts()}]        ${p.coin.padEnd(10)} ${side} ${Math.abs(p.size)} @ $${p.entryPrice.toFixed(2)} | uPnL: ${pnlColor}$${p.unrealizedPnl.toFixed(2)}${ANSI.reset}${p.liquidationPrice ? ` | liq: $${p.liquidationPrice.toFixed(2)}` : ''}`,
        )
      }
    } else {
      console.log(`[${ts()}] ${ANSI.dim}POS${ANSI.reset}   | no open positions`)
    }

    if (pool.isMultiWallet()) {
      console.log(`[${ts()}] ${ANSI.dim}POOL${ANSI.reset}  | Multi-wallet mode: ${pool.getStrategyIds().join(', ')}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[${ts()}] ${ANSI.yellow}ACCT${ANSI.reset}  | Could not fetch account info: ${msg}`)
    if (PAPER_TRADE) {
      console.log(`[${ts()}] ${ANSI.bold}${ANSI.yellow}MODE${ANSI.reset}  | PAPER TRADE — continuing without wallet`)
    }
  }

  // 8. Start health monitor periodic check (S13: Self-Healing)
  health.startPeriodicCheck()

  // 9. Wire agent components (S16: end-to-end integration + S7: multi-strategy wiring)
  const agent = getAgent()
  const om = getOrderManager()
  const pm = getPositionMonitor()
  const bridge = getInvalidationBridge()

  // Sprint 4.5: Wire ExchangePool to OrderManager for per-strategy exchange routing
  om.setExchangePool(pool)

  // Load active orders from DB (crash recovery R1)
  await om.loadActiveOrders()

  // Agent ← Pipeline (setup events)
  agent.subscribeToPipeline(getPipelineEmitter())

  // InvalidationBridge ← Pipeline (invalidation events) → Agent
  bridge.connect(getPipelineEmitter(), agent)

  // Agent → OrderManager (bidirectional) — dispatch includes strategyId (Sprint 4.5)
  agent.onAction(action => om.handleAction(action))
  om.setAgentDispatch((coin, event, strategyId) => agent.dispatch(coin, event, strategyId))

  // Agent → PositionMonitor (dispatch back with strategyId)
  pm.setAgentDispatch((coin, event, strategyId) => agent.dispatch(coin, event, strategyId))

  // PositionMonitor → OrderManager: trail stop SL updates go directly to exchange
  pm.setUpdateStopCallback((parentOrderId, newSlPrice) => om.modifySLPrice(parentOrderId, newSlPrice))

  // Sprint 4.5: Wire equity update from position monitor → agent (for portfolio risk)
  pm.setEquityCallback(equity => agent.setAccountEquity(equity))

  // Start exchange sync heartbeat (R3: 10s interval)
  pm.startSync()

  // Wire metrics service: refresh matviews after each trade close
  connectMetrics(agent)

  // Start Telegram bot (long-polling command interface)
  await startBot()

  log.info('agent', `Agent wired: ${strategyIds.length} strategies + exchange pool + order manager + position monitor + invalidation bridge + Telegram bot`)

  // Wire agent actions → TUI signals log
  agent.onAction(action => appendSignal(action))

  // 10. Start coin refresh loop
  selector.startRefreshLoop()

  // 11. Start TUI dashboard (replaces old console.log STATUS interval)
  startTui({
    getAgentSnapshot: () => agent.getSnapshot(),
    getPositions: () => pm.getPositions(),
    getStatus: () => getStatus(),
    getHealthReport: () => health.getReport(),
    getAccountState: () => {
      try {
        return pool.getShared().getAccountState()
      } catch {
        return null
      }
    },
    getSubscriptionCount,
    getTrackedCoins: () => selector.getTrackedCoins(),
  })

  // 12. Staleness watchdog (candles + order book)
  activeIntervals.push(setInterval(() => {
    checkStaleness()
    checkBookStaleness()
  }, STALENESS_CHECK_INTERVAL_MS))

  // Keep alive — resolve when WS dies (detected via staleness or thrown error)
  await new Promise(() => {
    // intentionally never resolves — process stays alive via setIntervals
  })
}

/** Clean up intervals, WS connections, refresh loop, polling, agent sync, TUI, and DB before reconnect. */
async function cleanup(): Promise<void> {
  stopTui()
  selector.stopRefreshLoop()
  getPositionMonitor().stopSync()
  stopBot()
  for (const id of activeIntervals) clearInterval(id)
  activeIntervals.length = 0
  stopFundingPolling()
  await stopOiFeed()
  await closeAll()
}

/** Run main() with exponential backoff reconnection on failure. */
async function runWithReconnect(): Promise<never> {
  let delay = WS_RECONNECT_INITIAL_MS

  // SIGINT handler — register once, outside retry loop
  process.on('SIGINT', async () => {
    console.log(`\n${ANSI.bold}${ANSI.yellow}[SHUTDOWN]${ANSI.reset} Closing connections...`)
    getHealthMonitor().stopPeriodicCheck()
    getPositionMonitor().stopSync()
    await cleanup()
    await closeDb()
    console.log(`${ANSI.bold}${ANSI.yellow}[SHUTDOWN]${ANSI.reset} Minh stopped gracefully.`)
    process.exit(0)
  })

  while (true) {
    try {
      await main()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${ts()}] CONNECTION LOST | ${msg}`)
      console.log(`[${ts()}] RECONNECT | retrying in ${Math.round(delay / 1000)}s...`)

      // Tear down everything before retry
      await cleanup()

      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(delay * WS_RECONNECT_BACKOFF, WS_RECONNECT_MAX_MS)

      console.log(`[${ts()}] RECONNECT | restarting subscriptions + backfill...`)
    }
  }
}

function ts(): string {
  return new Date().toISOString().slice(11, 19)
}

runWithReconnect()
