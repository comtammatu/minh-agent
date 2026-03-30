import type { CandleInterval } from './types.js'

/** Fallback coins if fetchTopCoins fails at startup (should not normally be used). */
export const FALLBACK_COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'TAO'] as const

/** Number of top coins by OI to track (after volume filter). */
export const TOP_COINS_LIMIT = 15

/** Minimum 24h notional volume ($) to qualify for tracking. */
export const MIN_24H_VOLUME = 500_000

/** How often to refresh the top coins list (ms). */
export const COIN_REFRESH_INTERVAL_MS = 3_600_000  // 1 hour

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const

export const MIN_CONFIDENCE = 0.4

export const REGIME_MULTIPLIERS = {
  aligned: 1.0,
  neutral: 0.8,
  counter: 0.3,
} as const

// Minimum candles required before scanning
export const MIN_CANDLES_FOR_SCAN = 50

// Candles to fetch per REST backfill call (per TF)
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
/** Default fallback if TF not in map. */
export const BACKFILL_CANDLE_COUNT = 5000

// Max concurrent REST backfill requests
export const BACKFILL_CONCURRENCY = 10

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

// Volume profile bins — computed as priceRange / numBins
export const VP_BINS = 50

// Value area percentage for volume profile (70% = standard)
export const VP_VALUE_AREA_PCT = 0.7

// Pattern TTL in bars (how long a setup stays active before expiring)
export const PATTERN_TTL_BARS = {
  'order-block': 20,
  'fvg': 10,
  'spring': 15,
  'demand-zone': 25,
  'breakout': 5,
  'vsa-signal': 8,
  'price-action': 6,
  'volume-profile': 12,
} as const

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

/** Simulated account size for risk filter (Sprint 1, no wallet). */
export const SIMULATED_ACCOUNT = 10_000

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
export const FUNDING_CONTRARIAN_THRESHOLD = -0.0001

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

/** Default risk per trade as fraction of account (1%). */
export const DEFAULT_RISK_PERCENT = 0.01

/** ATR stop multipliers by trade style. */
export const ATR_STOP_MULTIPLIER = {
  tight: 1.0,     // scalping / day trade
  standard: 1.5,  // swing trade — recommended default
  wide: 2.0,      // position trade
  veryWide: 2.5,  // volatile crypto / weekly
} as const

/** ATR buffer added below structure stop (Section 12.2 Method 1). */
export const STRUCTURE_STOP_ATR_BUFFER = 0.5

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
