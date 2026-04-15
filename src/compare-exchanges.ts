/**
 * compare-exchanges.ts — Cross-exchange signal comparison tool.
 *
 * Backfills HL + Bybit for COMMON_COINS, runs strategy pipeline on each,
 * then reports candle deltas + signal differences side-by-side.
 *
 * Usage:
 *   bun run src/compare-exchanges.ts                  # backfill only, compare candles + signals
 *   bun run src/compare-exchanges.ts --live           # backfill + WS, live comparison stream
 *   bun run src/compare-exchanges.ts --coins BTC,ETH  # override coin list
 *   bun run src/compare-exchanges.ts --tf 1h,4h       # override timeframes (default: SIGNAL_TIMEFRAMES)
 *
 * Design:
 *   Phase 1: Backfill both exchanges → store (HL: and BB: prefixed keys)
 *   Phase 2: For each exchange, copy candles into default prefix → run strategies → collect signals
 *   Phase 3: Compare + report (candle deltas, signal alignment, confidence gaps)
 *   Phase 4 (--live): WS subscribe both → on each closed candle, run + compare in real-time
 *
 * Note: Layered pipeline reads HTF candles from store via default 'HL' prefix.
 *       We work around this by populating the default prefix before each exchange's scan.
 */

import { HLFeed } from './feed/hl-feed.js'
import { BybitFeed } from './feed/bybit/bybit-feed.js'
import type { IExchangeFeed } from './feed/exchange-feed.js'
import {
  setCandles,
  getCandles,
  appendCandle,
  clearStore,
  candleCount,
} from './feed/store.js'
import { getSetupGeneratorWindowRequirements, resetSetupGenerator, runSetupGenerator } from './strategy/engine.js'
import { getPipelineEmitter, clearPipelineState } from './strategy/orchestrator.js'
import type {
  Candle,
  CandleInterval,
  ExchangeId,
  Signal,
  ActiveSetup,
} from './types.js'
import {
  COMMON_COINS,
  SIGNAL_TIMEFRAMES,
  TIMEFRAMES,
  PLANNING_WINDOW_BARS,
  READY_BARS,
} from './config.js'
import { log } from './lib/logger.js'

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const isLive = args.includes('--live')

function parseListArg(flag: string): string[] | null {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return null
  return args[idx + 1]!.split(',').map(s => s.trim()).filter(Boolean)
}

const coins = parseListArg('--coins') ?? COMMON_COINS
const signalTfs = (parseListArg('--tf') ?? [...SIGNAL_TIMEFRAMES]) as CandleInterval[]
const allTfs = [...TIMEFRAMES] as CandleInterval[]

// ── Types ───────────────────────────────────────────────────────────────────

interface CollectedSignal {
  exchange: ExchangeId
  coin: string
  interval: CandleInterval
  signal: Signal
  timestamp: number
}

interface CandleComparison {
  coin: string
  interval: CandleInterval
  hlCount: number
  bbCount: number
  /** Number of candles with matching timestamps on both exchanges */
  matchedBars: number
  /** Average absolute close price difference (%) across matched bars */
  avgCloseDiffPct: number
  /** Max absolute close price difference (%) */
  maxCloseDiffPct: number
  /** Average volume ratio (BB vol / HL vol) across matched bars */
  avgVolumeRatio: number
  /** Timestamp range overlap (ms) */
  overlapStart: number
  overlapEnd: number
}

interface SignalMatch {
  coin: string
  interval: CandleInterval
  hlSignal: CollectedSignal | null
  bbSignal: CollectedSignal | null
  /** Absolute entry price difference (%) — null if only one exchange */
  entryDiffPct: number | null
  /** Confidence delta (HL - BB) — null if only one exchange */
  confDelta: number | null
  /** Same side? */
  sameSide: boolean | null
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pct(a: number, b: number): number {
  if (b === 0) return 0
  return Math.abs(a - b) / Math.abs(b) * 100
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals)
}

function now(): string {
  return new Date().toISOString().slice(11, 19)
}

// ── Phase 1: Backfill ───────────────────────────────────────────────────────

async function backfillExchange(
  feed: IExchangeFeed,
  exchangeId: ExchangeId,
): Promise<void> {
  const label = exchangeId === 'HL' ? 'Hyperliquid' : 'Bybit'
  console.log(`\n[${now()}] ⏳ Backfilling ${label} (${coins.length} coins × ${allTfs.length} TFs)...`)

  const results = await feed.backfill(
    coins,
    (coin, interval, candles) => {
      setCandles(coin, interval, candles, exchangeId)
    },
  )

  let totalCandles = 0
  for (const coin of coins) {
    for (const tf of allTfs) {
      totalCandles += candleCount(coin, tf, exchangeId)
    }
  }

  const readyCounts = results.map(r => r.readyTFs)
  const fullyReady = readyCounts.filter(r => r === allTfs.length).length
  console.log(`[${now()}] ✅ ${label}: ${totalCandles} candles loaded | ${fullyReady}/${coins.length} fully ready`)
}

// ── Phase 2: Compare candle data ────────────────────────────────────────────

function compareCandles(): CandleComparison[] {
  const results: CandleComparison[] = []

  for (const coin of coins) {
    for (const tf of signalTfs) {
      const hlCandles = getCandles(coin, tf, 10_000, 'HL')
      const bbCandles = getCandles(coin, tf, 10_000, 'BB')

      if (hlCandles.length === 0 && bbCandles.length === 0) continue

      // Build timestamp → candle maps
      const hlMap = new Map<number, Candle>()
      for (const c of hlCandles) hlMap.set(c.t, c)
      const bbMap = new Map<number, Candle>()
      for (const c of bbCandles) bbMap.set(c.t, c)

      // Find overlapping timestamps
      const matched: Array<{ hl: Candle; bb: Candle }> = []
      for (const [t, hlC] of hlMap) {
        const bbC = bbMap.get(t)
        if (bbC) matched.push({ hl: hlC, bb: bbC })
      }

      let totalCloseDiff = 0
      let maxCloseDiff = 0
      let totalVolRatio = 0

      for (const { hl, bb } of matched) {
        const closeDiff = pct(hl.c, bb.c)
        totalCloseDiff += closeDiff
        if (closeDiff > maxCloseDiff) maxCloseDiff = closeDiff

        const volRatio = hl.v > 0 ? bb.v / hl.v : 0
        totalVolRatio += volRatio
      }

      const overlapTimes = matched.map(m => m.hl.t)

      results.push({
        coin,
        interval: tf,
        hlCount: hlCandles.length,
        bbCount: bbCandles.length,
        matchedBars: matched.length,
        avgCloseDiffPct: matched.length > 0 ? totalCloseDiff / matched.length : 0,
        maxCloseDiffPct: maxCloseDiff,
        avgVolumeRatio: matched.length > 0 ? totalVolRatio / matched.length : 0,
        overlapStart: overlapTimes.length > 0 ? Math.min(...overlapTimes) : 0,
        overlapEnd: overlapTimes.length > 0 ? Math.max(...overlapTimes) : 0,
      })
    }
  }

  return results
}

// ── Phase 3: Run strategies per exchange ────────────────────────────────────

function runStrategiesForExchange(exchangeId: ExchangeId): CollectedSignal[] {
  const collected: CollectedSignal[] = []

  // 1. Populate default (HL:) store prefix with this exchange's candles
  //    so layered pipeline's getCandles(coin, htf) finds the right data
  for (const coin of coins) {
    for (const tf of allTfs) {
      const candles = getCandles(coin, tf, 10_000, exchangeId)
      if (candles.length > 0) {
        setCandles(coin, tf, candles, 'HL')
      }
    }
  }

  // 2. Reset the concrete scanner before each exchange run
  resetSetupGenerator()

  // 3. Listen for layered/quant signals via pipelineEmitter (singleton)
  const emitter = getPipelineEmitter()
  const onSetup = (setup: ActiveSetup) => {
      collected.push({
        exchange: exchangeId,
        coin: setup.coin,
        interval: setup.interval,
        signal: {
        type: setup.type,
        side: setup.side,
        confidence: setup.confidence,
        entryPrice: setup.entryPrice,
        slPrice: setup.slPrice,
        tpPrice: setup.tpPrice,
        patternData: setup.patternData,
        ...(setup.confluenceGrade !== undefined ? { confluenceGrade: setup.confluenceGrade } : {}),
        ...(setup.confluenceCount !== undefined ? { confluenceCount: setup.confluenceCount } : {}),
      },
      timestamp: setup.detectedAt,
    })
  }
  emitter.on('setup', onSetup)

  // 4. Run closed-bar scan for each coin/TF
  const reqs = getSetupGeneratorWindowRequirements()

  for (const coin of coins) {
    for (const tf of signalTfs) {
      const planWindow = reqs.planningBars[tf] ?? PLANNING_WINDOW_BARS[tf]
      const candles = getCandles(coin, tf, planWindow + 2, 'HL') // reads from default prefix
      if (candles.length < (READY_BARS[tf] ?? 50) + 1) continue

      const idx = candles.length - 2
      const signal = runSetupGenerator(coin, tf, candles, idx)
      if (signal !== null) {
        collected.push({
          exchange: exchangeId,
          coin,
          interval: tf,
          signal,
          timestamp: Date.now(),
        })
      }
    }
  }

  // 5. Cleanup
  emitter.removeListener('setup', onSetup)

  // Clear module-level orchestrator state to avoid contamination
  clearPipelineState()

  return collected
}

// ── Phase 4: Match + compare signals ────────────────────────────────────────

function matchSignals(
  hlSignals: CollectedSignal[],
  bbSignals: CollectedSignal[],
): SignalMatch[] {
  const matches: SignalMatch[] = []

  // Key: coin|interval|side
  type SigKey = string
  function sigKey(s: CollectedSignal): SigKey {
    return `${s.coin}|${s.interval}|${s.signal.side}`
  }

  const hlMap = new Map<SigKey, CollectedSignal>()
  for (const s of hlSignals) {
    const k = sigKey(s)
    // Keep highest confidence if duplicates
    const existing = hlMap.get(k)
    if (!existing || s.signal.confidence > existing.signal.confidence) {
      hlMap.set(k, s)
    }
  }

  const bbMap = new Map<SigKey, CollectedSignal>()
  for (const s of bbSignals) {
    const k = sigKey(s)
    const existing = bbMap.get(k)
    if (!existing || s.signal.confidence > existing.signal.confidence) {
      bbMap.set(k, s)
    }
  }

  // Union of all keys
  const allKeys = new Set([...hlMap.keys(), ...bbMap.keys()])

  for (const k of allKeys) {
    const hl = hlMap.get(k) ?? null
    const bb = bbMap.get(k) ?? null

    const parts = k.split('|')
    const coin = parts[0]!
    const interval = parts[1]! as CandleInterval

    let entryDiffPct: number | null = null
    let confDelta: number | null = null
    let sameSide: boolean | null = null

    if (hl && bb) {
      entryDiffPct = pct(hl.signal.entryPrice, bb.signal.entryPrice)
      confDelta = hl.signal.confidence - bb.signal.confidence
      sameSide = hl.signal.side === bb.signal.side
    }

    matches.push({
      coin,
      interval,
      hlSignal: hl,
      bbSignal: bb,
      entryDiffPct,
      confDelta,
      sameSide,
    })
  }

  return matches
}

// ── Phase 5: Live WS comparison ─────────────────────────────────────────────

async function startLiveComparison(
  hlFeed: IExchangeFeed,
  bbFeed: IExchangeFeed,
): Promise<void> {
  console.log(`\n[${now()}] 🔴 LIVE MODE — subscribing to WS for both exchanges...`)

  const liveSignals = new Map<string, { hl?: CollectedSignal; bb?: CollectedSignal; ts: number }>()

  // Helper: on new closed candle, run strategies and compare
  function onClosedCandle(
    exchangeId: ExchangeId,
    coin: string,
    interval: CandleInterval,
    candle: Candle,
  ): void {
    // Store the candle under exchange prefix
    appendCandle(coin, interval, candle, exchangeId)

    // Only signal timeframes
    if (!signalTfs.includes(interval)) return

    // Also copy to default prefix for layered HTF
    appendCandle(coin, interval, candle, 'HL')

    // Run smc-sd directly (pure, no store dependency beyond passed candles)
    const planWindow = getSetupGeneratorWindowRequirements().planningBars[interval] ?? PLANNING_WINDOW_BARS[interval]
    const candles = getCandles(coin, interval, planWindow + 2, exchangeId)
    if (candles.length < (READY_BARS[interval] ?? 50) + 1) return

    const idx = candles.length - 2
    const signal = runSetupGenerator(coin, interval, candles, idx)

    if (signal) {
      const key = `${coin}|${interval}|${candle.t}`
      const entry = liveSignals.get(key) ?? { ts: Date.now() }
      const collected: CollectedSignal = {
        exchange: exchangeId,
        coin,
        interval,
        signal,
        timestamp: Date.now(),
      }

      if (exchangeId === 'HL') entry.hl = collected
      else entry.bb = collected
      liveSignals.set(key, entry)

      // If both exchanges have reported for this bar, print comparison
      if (entry.hl && entry.bb) {
        const diff = pct(entry.hl.signal.entryPrice, entry.bb.signal.entryPrice)
        const confDiff = entry.hl.signal.confidence - entry.bb.signal.confidence
        const sideMatch = entry.hl.signal.side === entry.bb.signal.side
        console.log(
          `[${now()}] ⚡ LIVE MATCH | ${coin} ${interval} smc-sd | ` +
          `side: ${sideMatch ? '✅ same' : `❌ HL=${entry.hl.signal.side} BB=${entry.bb.signal.side}`} | ` +
          `entry: HL=$${fmt(entry.hl.signal.entryPrice)} BB=$${fmt(entry.bb.signal.entryPrice)} (Δ${fmt(diff)}%) | ` +
          `conf: HL=${fmt(entry.hl.signal.confidence)} BB=${fmt(entry.bb.signal.confidence)} (Δ${fmt(confDiff, 3)})`,
        )
        liveSignals.delete(key)
      } else {
        // Print solo signal
        const tag = exchangeId === 'HL' ? 'HL-only' : 'BB-only'
        console.log(
          `[${now()}] ⚡ LIVE ${tag} | ${coin} ${interval} smc-sd ${signal.side} | ` +
          `entry=$${fmt(signal.entryPrice)} conf=${fmt(signal.confidence)}`,
        )
      }
    }
  }

  // Subscribe HL
  await hlFeed.subscribe(coins, (coin, interval, candle) => {
    onClosedCandle('HL', coin, interval, candle)
  })

  // Subscribe BB
  await bbFeed.subscribe(coins, (coin, interval, candle) => {
    onClosedCandle('BB', coin, interval, candle)
  })

  console.log(`[${now()}] ✅ WS subscribed — waiting for closed candles (Ctrl+C to stop)\n`)

  // Staleness check every 30s
  setInterval(() => {
    hlFeed.checkStaleness()
    bbFeed.checkStaleness()
  }, 30_000)

  // Cleanup stale entries every 5 min
  setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000
    for (const [k, v] of liveSignals) {
      if (v.ts < cutoff) liveSignals.delete(k)
    }
  }, 5 * 60 * 1000)

  // Keep alive
  await new Promise(() => {})
}

// ── Reporting ───────────────────────────────────────────────────────────────

function printCandleReport(comparisons: CandleComparison[]): void {
  console.log('\n' + '═'.repeat(100))
  console.log('  CANDLE DATA COMPARISON (HL vs Bybit)')
  console.log('═'.repeat(100))

  // Group by coin
  const byCoin = new Map<string, CandleComparison[]>()
  for (const c of comparisons) {
    const arr = byCoin.get(c.coin) ?? []
    arr.push(c)
    byCoin.set(c.coin, arr)
  }

  for (const [coin, comps] of byCoin) {
    console.log(`\n  ${coin}:`)
    console.log(`  ${'TF'.padEnd(6)} ${'HL'.padStart(7)} ${'BB'.padStart(7)} ${'Match'.padStart(7)} ${'ΔClose%'.padStart(9)} ${'MaxΔ%'.padStart(9)} ${'VolRatio'.padStart(10)}`)
    console.log(`  ${'─'.repeat(56)}`)

    for (const c of comps) {
      console.log(
        `  ${c.interval.padEnd(6)} ${String(c.hlCount).padStart(7)} ${String(c.bbCount).padStart(7)} ` +
        `${String(c.matchedBars).padStart(7)} ${fmt(c.avgCloseDiffPct, 4).padStart(9)} ` +
        `${fmt(c.maxCloseDiffPct, 4).padStart(9)} ${fmt(c.avgVolumeRatio, 2).padStart(10)}`,
      )
    }
  }

  // Summary stats
  const totalMatched = comparisons.reduce((s, c) => s + c.matchedBars, 0)
  const avgDiff = comparisons.length > 0
    ? comparisons.reduce((s, c) => s + c.avgCloseDiffPct, 0) / comparisons.length
    : 0

  console.log(`\n  Summary: ${totalMatched} matched bars across ${comparisons.length} coin/TF pairs | avg close diff: ${fmt(avgDiff, 4)}%`)
}

function printSignalReport(matches: SignalMatch[]): void {
  console.log('\n' + '═'.repeat(100))
  console.log('  SIGNAL COMPARISON (HL vs Bybit) — last closed bar')
  console.log('═'.repeat(100))

  const bothExchanges = matches.filter(m => m.hlSignal && m.bbSignal)
  const hlOnly = matches.filter(m => m.hlSignal && !m.bbSignal)
  const bbOnly = matches.filter(m => !m.hlSignal && m.bbSignal)

  // Signals found on BOTH exchanges
  if (bothExchanges.length > 0) {
    console.log(`\n  ✅ MATCHED (both exchanges): ${bothExchanges.length}`)
    console.log(`  ${'Coin'.padEnd(8)} ${'TF'.padEnd(5)} ${'Engine'.padEnd(8)} ${'Side'.padEnd(6)} ${'HL Entry'.padStart(12)} ${'BB Entry'.padStart(12)} ${'ΔEntry%'.padStart(9)} ${'HL Conf'.padStart(8)} ${'BB Conf'.padStart(8)} ${'ΔConf'.padStart(7)}`)
    console.log(`  ${'─'.repeat(84)}`)

    for (const m of bothExchanges) {
      const hl = m.hlSignal!.signal
      const bb = m.bbSignal!.signal
      console.log(
        `  ${m.coin.padEnd(8)} ${m.interval.padEnd(5)} ${'smc-sd'.padEnd(8)} ${hl.side.padEnd(6)} ` +
        `${('$' + fmt(hl.entryPrice)).padStart(12)} ${('$' + fmt(bb.entryPrice)).padStart(12)} ` +
        `${fmt(m.entryDiffPct!, 4).padStart(9)} ${fmt(hl.confidence, 2).padStart(8)} ` +
        `${fmt(bb.confidence, 2).padStart(8)} ${(m.confDelta! >= 0 ? '+' : '') + fmt(m.confDelta!, 3)}`.padStart(7),
      )
    }
  }

  // HL-only signals
  if (hlOnly.length > 0) {
    console.log(`\n  🔵 HL-ONLY: ${hlOnly.length}`)
    for (const m of hlOnly) {
      const s = m.hlSignal!.signal
      console.log(`  ${m.coin.padEnd(8)} ${m.interval.padEnd(5)} ${'smc-sd'.padEnd(8)} ${s.side.padEnd(6)} entry=$${fmt(s.entryPrice)} conf=${fmt(s.confidence)}`)
    }
  }

  // BB-only signals
  if (bbOnly.length > 0) {
    console.log(`\n  🟡 BB-ONLY: ${bbOnly.length}`)
    for (const m of bbOnly) {
      const s = m.bbSignal!.signal
      console.log(`  ${m.coin.padEnd(8)} ${m.interval.padEnd(5)} ${'smc-sd'.padEnd(8)} ${s.side.padEnd(6)} entry=$${fmt(s.entryPrice)} conf=${fmt(s.confidence)}`)
    }
  }

  // Summary
  const total = matches.length
  console.log(`\n  Summary: ${total} unique signals | ${bothExchanges.length} matched | ${hlOnly.length} HL-only | ${bbOnly.length} BB-only`)

  if (bothExchanges.length > 0) {
    const avgEntryDiff = bothExchanges.reduce((s, m) => s + (m.entryDiffPct ?? 0), 0) / bothExchanges.length
    const avgConfDelta = bothExchanges.reduce((s, m) => s + Math.abs(m.confDelta ?? 0), 0) / bothExchanges.length
    console.log(`  Matched signals: avg entry diff=${fmt(avgEntryDiff, 4)}% | avg |conf delta|=${fmt(avgConfDelta, 3)}`)
  }

  if (total === 0) {
    console.log('\n  No signals detected on either exchange for the last closed bar.')
    console.log('  This is normal — signals are rare. Try --live mode for continuous comparison.')
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Bypass ACTIVE_EXCHANGE requirement — this script uses both
  process.env['ACTIVE_EXCHANGE'] = 'HL'

  console.log('═'.repeat(100))
  console.log('  Minh (明) — Cross-Exchange Signal Comparison')
  console.log('═'.repeat(100))
  console.log(`  Coins:      ${coins.join(', ')}`)
  console.log(`  Signal TFs: ${signalTfs.join(', ')}`)
  console.log(`  All TFs:    ${allTfs.join(', ')}`)
  console.log(`  Mode:       ${isLive ? 'LIVE (backfill + WS)' : 'SNAPSHOT (backfill only)'}`)

  const hlFeed: IExchangeFeed = new HLFeed()
  const bbFeed: IExchangeFeed = new BybitFeed()

  // ── Phase 1: Backfill both exchanges ──────────────────────────────────
  await backfillExchange(hlFeed, 'HL')
  await backfillExchange(bbFeed, 'BB')

  // ── Phase 2: Compare candle data ──────────────────────────────────────
  const candleComparisons = compareCandles()
  printCandleReport(candleComparisons)

  // ── Phase 3: Run strategies per exchange ──────────────────────────────
  console.log(`\n[${now()}] 🧠 Running strategies on HL candles...`)
  const hlSignals = runStrategiesForExchange('HL')
  console.log(`[${now()}] HL: ${hlSignals.length} signals`)

  console.log(`[${now()}] 🧠 Running strategies on BB candles...`)
  const bbSignals = runStrategiesForExchange('BB')
  console.log(`[${now()}] BB: ${bbSignals.length} signals`)

  // ── Phase 4: Compare signals ──────────────────────────────────────────
  const matches = matchSignals(hlSignals, bbSignals)
  printSignalReport(matches)

  // ── Phase 5: Live mode (optional) ─────────────────────────────────────
  if (isLive) {
    await startLiveComparison(hlFeed, bbFeed)
  } else {
    // Clean shutdown
    await hlFeed.closeAll()
    await bbFeed.closeAll()
    console.log(`\n[${now()}] Done. Use --live for continuous comparison.\n`)
    process.exit(0)
  }
}

// ── SIGINT handler ──────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\nShutting down...')
  process.exit(0)
})

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
