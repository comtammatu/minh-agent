import type { CandleInterval } from './types.js'

/** Fallback coins if fetchTopCoins fails at startup (should not normally be used). */
export const FALLBACK_COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'TAO'] as const

/** Number of top coins by OI to track. */
export const TOP_COINS_LIMIT = 50

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

// Candles to fetch per REST backfill call
export const BACKFILL_CANDLE_COUNT = 5000

// Max concurrent REST backfill requests (respect HL 800 req/min rate limit)
export const BACKFILL_CONCURRENCY = 20

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
