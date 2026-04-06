import type { CandleInterval } from './types.js'

/** Fallback coins if fetchTopCoins fails at startup (should not normally be used). */
export const FALLBACK_COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'TAO'] as const

/** Number of top coins by OI to track (after volume filter). */
export const TOP_COINS_LIMIT = 20

/** Minimum 24h notional volume ($) to qualify for tracking. */
export const MIN_24H_VOLUME = 500_000

/** How often to refresh the top coins list (ms). */
export const COIN_REFRESH_INTERVAL_MS = 3_600_000  // 1 hour

// ── HIP-3 (builder-deployed perps) ────────────────────────────────────────
/** Which HIP-3 DEXes to track (e.g., 'xyz' for traditional finance assets). */
export const HIP3_DEXES: string[] = ['xyz']

/** Number of top HIP-3 coins by OI to track (separate from native perps). */
export const HIP3_TOP_COINS_LIMIT = 5

/** Minimum 24h volume ($) for HIP-3 coins. */
export const HIP3_MIN_24H_VOLUME = 500_000

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const

// TFs that generate signals. 1m excluded — used only for entry refinement on 5m/15m signals.
export const SIGNAL_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'] as const

export const MIN_CONFIDENCE = 0.4

export const REGIME_MULTIPLIERS = {
  aligned: 1.0,
  neutral: 0.8,
  counter: 0.3,
} as const

// Minimum candles required before scanning
export const MIN_CANDLES_FOR_SCAN = 50

// Total candles to fetch per TF during backfill
// Small TFs: 500 candles (low weight, recent data sufficient for structure)
// Large TFs: 5000 candles (full history for regime/structure detection)
export const BACKFILL_CANDLE_COUNTS: Record<string, number> = {
  '1m': 500,
  '5m': 500,
  '15m': 5000,
  '1h': 5000,
  '4h': 5000,
  '1d': 5000,
}

// Max candles per single REST request (HL 500 errors above this)
export const BACKFILL_BATCH_SIZE = 500
/** Default fallback if TF not in map. */
export const BACKFILL_CANDLE_COUNT = 5000

// Max concurrent REST backfill requests (keep low to avoid HL 500s)
export const BACKFILL_CONCURRENCY = 3

// Max rounds to replace coins that fail backfill (0 readyTFs) at startup
export const BACKFILL_REPLACEMENT_ROUNDS = 2

// HL REST weight budget: 1200/min per IP.
// candleSnapshot weight = 20 base + ceil(items/60) surcharge.
//   500 candles → ~29 weight, 5000 candles → ~104 weight
// Burst 12 (~600 weight) + sustained 1 req/3s (~20 req/min, ~800 weight/min avg)
export const REST_BURST_TOKENS = 12
export const REST_REFILL_MS = 3_000

// Candles to use for indicator calculation
export const INDICATOR_WINDOW = 200

// Staleness: warn if no candle received in this many ms
export const STALENESS_THRESHOLD_MS = 60_000

// Staleness watchdog checks every N ms
export const STALENESS_CHECK_INTERVAL_MS = 30_000

// Status line printed every N ms
export const STATUS_INTERVAL_MS = 60_000

// ATR multiplier for zone proximity buffer (confirm layer)
export const ZONE_BUFFER_ATR_MULT = 0.3

// ATR multiplier for wick-based SL buffer (trigger layer)
// SL placed just beyond candle extreme instead of zone boundary for tighter R:R
export const SL_WICK_ATR_MULT = 0.3

// Volume profile lookback window for confirm layer
export const VP_LOOKBACK = 100

// Volume profile bins — computed as priceRange / numBins
export const VP_BINS = 50

// Value area percentage for volume profile (70% = standard)
export const VP_VALUE_AREA_PCT = 0.7

// Pattern TTL in bars (how long a setup stays active before expiring)
export const PATTERN_TTL_BARS: Record<string, number> = {
  'order-block': 20,
  'fvg': 10,
  'spring': 15,
  'demand-zone': 25,
  'breakout': 5,
  'vsa-signal': 8,
  'price-action': 6,
  'volume-profile': 12,
  'ema-rsi': 1,
  'smc-sd': 12,
}

// ─── SMC+S&D Zone Bounce Strategy ────────────────────────────────────────────

/** How many bars back to look for a BOS/CHoCH to establish direction. */
export const SMC_BREAK_LOOKBACK = 20

/** Minimum bars between signals on same coin/interval (dedup). */
export const SMC_DEDUP_BARS = 5

// ─── Layered Pipeline Config ─────────────────────────────────────────────────

/** Map each timeframe to its Higher Timeframe for Layer 1 HTF bias check. */
export const HTF_MAP: Record<CandleInterval, CandleInterval> = {
  '1m': '15m',
  '5m': '1h',
  '15m': '4h',
  '1h': '4h',
  '4h': '1d',
  '1d': '1d',
} as const

/** Minimum confluence count for grade B (alert threshold). */
export const CONFLUENCE_MIN = 3

/**
 * Max zone age in candles. Zones older than this are filtered out in L3.
 * Prevents stale zones (price moved far away) from inflating L3 pass rate.
 * 50 candles ≈ 12.5h on 15m, 50h on 1h, 200h (~8d) on 4h.
 */
export const ZONE_MAX_AGE = 50

/**
 * @deprecated Use real account balance from ExchangeService (R17).
 * Kept as fallback if ExchangeService is not initialized (tests, offline mode).
 */
export const SIMULATED_ACCOUNT = 10_000

// ─── Risk Management (S10) ──────────────────────────────────────────────────

/** Risk limits for position sizing and drawdown protection. */
export const RISK = {
  /** Max risk per trade as fraction of account (1%). */
  maxRiskPerTrade: 0.01,
  /** Max concurrent open positions. */
  maxConcurrentPositions: 3,
  /** Max daily loss as fraction of account (3%) → PAUSE agent. */
  maxDailyLoss: 0.03,
  /** Max weekly loss as fraction of account (5%) → PAUSE + alert. */
  maxWeeklyLoss: 0.05,
  /** Max single position size as fraction of account (10%). */
  maxPositionSize: 0.10,
  /** Max correlated assets in same direction. */
  maxCorrelatedPositions: 2,
  /** Max total notional exposure as multiple of account. */
  maxTotalExposure: 3.0,
} as const

// ─── Phase B: Order Flow Config ─────────────────────────────────────────────

/** Funding rate polling interval (ms). */
export const FUNDING_POLL_INTERVAL_MS = 60_000

/** Store last N hours of funding rates. */
export const FUNDING_HISTORY_HOURS = 24

/** Aggregate trades into delta buckets every N ms. */
export const DELTA_AGGREGATE_INTERVAL_MS = 1_000

/** Cap L2 book at top N levels each side. */
export const BOOK_DEPTH_LEVELS = 20

/** Warn if no book update in N ms. */
export const BOOK_STALENESS_MS = 30_000

/** Delta imbalance threshold: |buyVol - sellVol| / total > threshold. */
export const DELTA_STRONG_THRESHOLD = 0.6

/** Book imbalance threshold: |bidSize - askSize| / total > threshold. */
export const BOOK_IMBALANCE_THRESHOLD = 0.3

/** Negative funding rate threshold for contrarian boost. */
/**
 * Funding rate threshold for contrarian confirmation (absolute value).
 * Long boost when rate < -threshold (shorts paying longs).
 * Short boost when rate > +threshold (longs paying shorts).
 */
export const FUNDING_CONTRARIAN_THRESHOLD = 0.0001

// ─── Phase D: Asset Context / OI Config ────────────────────────────────────

/** OI spike threshold: deltaOI / prevOI > threshold → spike signal. */
export const OI_SPIKE_THRESHOLD = 0.05  // 5%

/** Mark/oracle divergence threshold: |mark - oracle| / oracle > threshold. */
export const MARK_ORACLE_DIVERGENCE_THRESHOLD = 0.005  // 0.5%

// ─── WebSocket Limits ─────────────────────────────────────────────────────

/** HL WS max subscriptions per IP (hard limit). */
export const WS_MAX_SUBSCRIPTIONS = 1_000

// ─── Timeframe Durations (ms) ────────────────────────────────────────────

/** Milliseconds per candle interval — used for gap-fill computation. */
export const TIMEFRAME_MS: Record<CandleInterval, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
  '1d':  86_400_000,
} as const

// ─── Circuit Breakers (S11) ────────────────────────────────────────────────

/** Circuit breaker thresholds and cooldown durations. */
export const CIRCUIT_BREAKER = {
  /** Daily loss limit as fraction of account (3%) → pause until next UTC day. */
  dailyLossLimit: 0.03,

  /** Consecutive losses (per-coin) to trigger pause. */
  consecutiveLossCount: 3,
  /** Consecutive loss pause duration (ms) — 2 hours. */
  consecutiveLossPauseMs: 2 * 60 * 60 * 1000,

  /** Rapid loss: max loss as fraction of account within the time window (2%). */
  rapidLossLimit: 0.02,
  /** Rapid loss time window (ms) — 1 hour. */
  rapidLossWindowMs: 60 * 60 * 1000,
  /** Rapid loss pause duration (ms) — 4 hours. */
  rapidLossPauseMs: 4 * 60 * 60 * 1000,

  /** Max drawdown from peak account value as fraction (10%) → pause + alert. */
  maxDrawdownLimit: 0.10,
} as const

// ─── Correlation Groups (S12) ─────────────────────────────────────────────

/**
 * Static correlation groups for anti-correlation guard.
 * Coins in the same group are considered correlated.
 * A coin can appear in multiple groups if it correlates with several ecosystems.
 * Unknown coins (not in any group) are treated as uncorrelated.
 */
export const CORRELATION_GROUPS: Record<string, readonly string[]> = {
  'btc-ecosystem': ['BTC', 'STX', 'ORDI', 'SATS', 'RUNE'],
  'eth-ecosystem': ['ETH', 'OP', 'ARB', 'STRK', 'BLAST', 'SCROLL', 'ZK', 'TAIKO', 'LINEA'],
  'sol-ecosystem': ['SOL', 'JTO', 'JUP', 'PYTH', 'WIF', 'BONK', 'RAY', 'ORCA'],
  'meme':          ['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME', 'MYRO', 'BRETT'],
  'ai':            ['FET', 'AGIX', 'OCEAN', 'RENDER', 'TAO', 'AKT', 'AR', 'NEAR'],
  'defi':          ['AAVE', 'UNI', 'MKR', 'CRV', 'COMP', 'DYDX', 'SNX', 'SUSHI'],
  'l1':            ['AVAX', 'DOT', 'ATOM', 'ADA', 'NEAR', 'SUI', 'APT', 'SEI', 'TIA', 'INJ'],
} as const

// ─── Database (R15: single-process, sequential writes) ────────────────────

/** Max connections in pool. */
export const DB_MAX_CONNECTIONS = 5

/** Idle connection timeout (seconds). */
export const DB_IDLE_TIMEOUT_S = 30

/** Connection attempt timeout (seconds). */
export const DB_CONNECT_TIMEOUT_S = 10

// ─── WebSocket Reconnection ────────────────────────────────────────────────

/** Initial delay before reconnection attempt (ms). */
export const WS_RECONNECT_INITIAL_MS = 1_000

/** Maximum delay between reconnection attempts (ms). */
export const WS_RECONNECT_MAX_MS = 30_000

/** Backoff multiplier per failed attempt. */
export const WS_RECONNECT_BACKOFF = 2

/** Zone distance → position sizing + minimum R:R. */
export const ZONE_RISK = {
  near: { maxDistance: 0.02, minRR: 1.5 },  // < 2%
  medium: { maxDistance: 0.05, minRR: 2.0 },  // 2–5%
  far: { maxDistance: 0.08, minRR: 3.0 },  // 5–8%
  skip: { maxDistance: 0.10 },               // > 10% → skip
} as const

// ─── Exit Strategy (Section 12) ─────────────────────────────────────────────

/** Default risk per trade as fraction of account (2%). Capped to limit max drawdown. */
export const DEFAULT_RISK_PERCENT = 0.02

/** ATR stop multipliers by trade style. */
export const ATR_STOP_MULTIPLIER = {
  tight: 1.0,     // scalping / day trade
  standard: 1.5,  // swing trade — recommended default
  wide: 2.0,      // position trade
  veryWide: 2.5,  // volatile crypto / weekly
} as const

/** ATR buffer added below structure stop (Section 12.2 Method 1). */
export const STRUCTURE_STOP_ATR_BUFFER = 0.7

/** Maximum stop distance as fraction of entry price. Beyond this → skip. */
export const MAX_STOP_DISTANCE_PCT = 0.10

/** Maximum leverage warning threshold. */
export const MAX_LEVERAGE_WARN = 5.0

/** Trailing stop config defaults. */
export const TRAILING_STOP = {
  activationPct: 0.01,  // activate trailing after +1% profit
  trailPct: 0.005,      // trail 0.5% below highest price
} as const

/** Partial close config defaults. */
export const PARTIAL_CLOSE = {
  firstTpRatio: 1.0,    // first TP at 1R
  firstClosePct: 0.5,   // close 50% at first TP
  moveSlToBreakeven: true,
  secondTpRatio: 2.0,   // second TP at 2R (trail rest)
} as const

/** Minimum position size as fraction of account. Below → skip. */
export const MIN_POSITION_SIZE_PCT = 0.001

/** Slippage buffer for stop market orders (Section 12.5). */
export const STOP_SLIPPAGE_BUFFER = 0.002  // 0.2%

// ─── Multi-TP Exit Strategy (Backtest) ─────────────────────────────────────

/** Per-timeframe ATR multiplier for trailing stop distance. */
export const ATR_TRAIL_MULTIPLIER: Record<CandleInterval, number> = {
  '1m': 1.0,
  '5m': 1.2,
  '15m': 1.5,
  '1h': 2.0,
  '4h': 2.5,
  '1d': 3.0,
} as const

/** Position split across 3 TP levels: TP1 (zone), TP2 (swing), TP3 (trail). */
export const MULTI_TP_SPLIT = [0.4, 0.3, 0.3] as const

/** Minimum R:R for TP1. TP1 must be at least this far from entry. */
export const MIN_TP1_RR = 1.5

/** Activate trailing stop after price moves this many R in profit. */
export const TRAIL_ACTIVATION_R = 1.0

// ─── Backtest (Sprint 3A) ──────────────────────────────────────────────────

/** Max months of history allowed for browser-triggered backtest (OOM guard). */
export const MAX_BACKTEST_MONTHS = 6

/** Bars between async yield points in browser backtest (keep event loop responsive). */
export const BACKTEST_CHUNK_SIZE = 100

/** Default slippage for backtest fills (0.05% = 5 bps). */
export const BACKTEST_SLIPPAGE_PCT = 0.0005

/** Default commission per trade for backtest (0.03% = 3 bps, HL taker fee). */
export const BACKTEST_COMMISSION_PCT = 0.0003

/** Walk-forward: default training window (30 days in ms). */
export const WF_TRAIN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** Walk-forward: default test (OOS) window (7 days in ms). */
export const WF_TEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Walk-forward: default step size (7 days — non-overlapping OOS). */
export const WF_STEP_MS = 7 * 24 * 60 * 60 * 1000

/** Walk-forward: minimum number of OOS windows required for valid analysis. */
export const WF_MIN_WINDOWS = 2

/** Walk-forward: overfit ratio threshold. IS/OOS > this = flagged. */
export const WF_OVERFIT_THRESHOLD = 2.0

/** Walk-forward: minimum OOS trades across all windows for statistical validity. */
export const WF_MIN_OOS_TRADES = 30

/** Walk-forward: bootstrap resampling iterations for CI estimation. */
export const WF_BOOTSTRAP_ITERATIONS = 1000

/** Walk-forward: confidence level for bootstrap CI (0.95 = 95%). */
export const WF_CONFIDENCE_LEVEL = 0.95

/** Walk-forward: minimum fraction of OOS windows with positive expectancy. */
export const WF_MIN_WINDOW_CONSISTENCY = 0.5

// ─── Quant Baseline Strategy ────────────────────────────────────────────────

/** EMA fast period for trend filter. */
export const QUANT_EMA_FAST = 50

/** EMA slow period for trend filter. */
export const QUANT_EMA_SLOW = 200

/** RSI period. */
export const QUANT_RSI_PERIOD = 14

/** RSI oversold threshold — buy signal in uptrend. Relaxed for crypto volatility on higher TFs. */
export const QUANT_RSI_OVERSOLD = 35

/** RSI overbought threshold — sell signal in downtrend. Relaxed for crypto volatility on higher TFs. */
export const QUANT_RSI_OVERBOUGHT = 65

/** ATR multiplier for stop loss distance. */
export const QUANT_ATR_SL_MULT = 2.0

/** ATR multiplier for take profit distance (1.5 R:R). */
export const QUANT_ATR_TP_MULT = 3.0

// ─── Portfolio Risk (Sprint 4.5 S6) ─────────────────────────────────────────

/** Portfolio-level risk limits across all strategies. */
export const PORTFOLIO_RISK = {
  /** Max total notional exposure as multiple of total account equity. */
  maxTotalExposure: 3.0,
  /** Max total concurrent positions across all strategies. */
  maxTotalConcurrent: 6,
  /** Per-strategy capital allocation as fraction of total account (must sum ≤ 1.0). */
  strategyAllocations: {
    layered: 0.35,
    quant: 0.35,
    'smc-sd': 0.30,
  } as Record<string, number>,
  /** Per-strategy max concurrent positions. */
  strategyMaxConcurrent: {
    layered: 3,
    quant: 3,
    'smc-sd': 2,
  } as Record<string, number>,
} as const

// ─── Strategy Wallets (Sprint 4.5 S4) ────────────────────────────────────────

/**
 * Per-strategy wallet configuration.
 * Each strategy can have its own agent wallet for signing orders.
 */
export interface WalletConfig {
  /** Agent wallet private key (0x-prefixed hex). */
  privateKey: string
  /** Main account address that the agent wallet trades on behalf of. */
  accountAddress: string
}

/**
 * Parse STRATEGY_WALLETS JSON env var into a Map<strategyId, WalletConfig>.
 *
 * Expected format:
 * ```json
 * {
 *   "layered": { "privateKey": "0x...", "accountAddress": "0x..." },
 *   "quant":   { "privateKey": "0x...", "accountAddress": "0x..." }
 * }
 * ```
 *
 * Returns empty Map if env var is not set (single-wallet fallback mode).
 * Throws on malformed JSON or invalid wallet config entries.
 */
export function parseStrategyWallets(): Map<string, WalletConfig> {
  const raw = process.env.STRATEGY_WALLETS
  if (!raw) return new Map()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('STRATEGY_WALLETS env var is not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('STRATEGY_WALLETS must be a JSON object { strategyId: { privateKey, accountAddress } }')
  }

  const result = new Map<string, WalletConfig>()
  for (const [strategyId, config] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error(`STRATEGY_WALLETS["${strategyId}"] must be an object with privateKey and accountAddress`)
    }
    const { privateKey, accountAddress } = config as Record<string, unknown>
    if (typeof privateKey !== 'string' || !privateKey.startsWith('0x')) {
      throw new Error(`STRATEGY_WALLETS["${strategyId}"].privateKey must be a 0x-prefixed hex string`)
    }
    if (typeof accountAddress !== 'string' || !accountAddress.startsWith('0x') || accountAddress.length !== 42) {
      throw new Error(`STRATEGY_WALLETS["${strategyId}"].accountAddress must be a valid 0x-prefixed Ethereum address (42 chars)`)
    }
    result.set(strategyId, { privateKey, accountAddress })
  }

  return result
}

// ─── Paper Trade Mode ─────────────────────────────────────────────────────────

/** Paper trade mode: simulate fills instead of calling HL exchange. */
export const PAPER_TRADE = process.env.PAPER_TRADE === 'true'

/** Slippage applied to paper fills (0.05% = 5 bps). */
export const PAPER_SLIPPAGE_PCT = 0.0005

// ─── Order Lifecycle (S6) ────────────────────────────────────────────────────

/** Order fill timeout (ms) — cancel entry if not filled. */
export const ORDER_FILL_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes

/** Max open orders per coin (enforces 1-position-per-coin rule). */
export const MAX_ORDERS_PER_COIN = 1

/** SL trigger order type: market (guaranteed fill on stop). */
export const SL_IS_MARKET = true

/** TP trigger order type: limit (better fill price on target). */
export const TP_IS_MARKET = false

// ─── Position Monitor (S7) ────────────────────────────────────────────────

/** Exchange-sync heartbeat interval (R3). Poll HL clearinghouseState. */
export const EXCHANGE_SYNC_INTERVAL_MS = 10_000  // 10 seconds

/** Minimum SL price change (fraction) to send update to exchange. Avoids rate limit burn. */
export const TRAIL_UPDATE_THRESHOLD = 0.001  // 0.1% minimum change before modifying SL on exchange

// ─── Self-Healing (S13) ────────────────────────────────────────────────────

/** Retry configuration for exchange API calls. */
export const RETRY = {
  /** Max attempts for exchange order/trigger calls. */
  exchangeMaxAttempts: 3,
  /** Max attempts for SL/TP placement retries. */
  slTpMaxAttempts: 3,
  /** Initial backoff delay (ms). */
  initialDelayMs: 500,
  /** Maximum backoff delay (ms). */
  maxDelayMs: 5_000,
  /** Backoff multiplier per attempt. */
  backoffMultiplier: 2,
  /** Jitter range (0–1). Adds up to this fraction of the delay as random jitter. */
  jitterFraction: 0.3,
} as const

// ─── Telegram Alerts (S14) ──────────────────────────────────────────────────

/** Telegram Bot API configuration. Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. */
export const TELEGRAM = {
  /** Environment variable name for bot token. */
  tokenEnv: 'TELEGRAM_BOT_TOKEN',
  /** Environment variable name for chat ID. */
  chatIdEnv: 'TELEGRAM_CHAT_ID',
  /** Telegram Bot API base URL. */
  apiBase: 'https://api.telegram.org',
  /** Request timeout (ms). */
  timeoutMs: 10_000,
} as const

/** Telegram Bot (command interface) configuration. */
export const TELEGRAM_BOT = {
  /** Long-polling timeout sent to Telegram API (seconds). */
  pollingTimeoutSec: 30,
  /** Extra seconds added to fetch timeout beyond pollingTimeoutSec. */
  pollingExtraTimeoutSec: 5,
  /** Max backoff between getUpdates retries (ms). */
  maxBackoffMs: 30_000,
  /** /closeall confirmation timeout (seconds). User must /confirm within this window. */
  closeallConfirmTimeoutSec: 30,
} as const

/** Health monitoring configuration. */
export const HEALTH = {
  /** RSS warning threshold (bytes). ~512MB. */
  rssWarnBytes: 512 * 1024 * 1024,
  /** RSS critical threshold (bytes). ~1024MB. */
  rssCriticalBytes: 1024 * 1024 * 1024,
  /** Health check interval (ms). */
  checkIntervalMs: 30_000,
  /** Staleness threshold for exchange API (ms) — no successful call in this window. */
  exchangeStaleMs: 60_000,
  /** Staleness threshold for DB writes (ms). */
  dbStaleMs: 60_000,
} as const
