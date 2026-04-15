import type { CandleInterval, ExchangeId } from './types.js'

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

/** Minimum confidence to emit a signal. Raised from 0.50→0.58:
 * bonus stacking (HTF+OTE+killzone+breaker) inflated confidence to where
 * trades with only 3 weak confluences still passed. 0.58 requires meaningful
 * conviction — base (0.65) + regime modifier (0.85×) still clears threshold. */
export const MIN_CONFIDENCE = 0.58

/** Regime confidence multipliers.
 * Counter 0.35→0.25: P2 raised to 0.35 for signal volume, but OOS bad weeks
 * (W261 WR 10%, W278 WR 33%) show too many counter-trend entries in bear runs.
 * 0.25 requires even stronger confluence: 0.65×0.25=0.16 base → needs +0.42
 * bonus (CHoCH+displacement+killzone+HTF). Legitimate pullbacks with 4+ confluence
 * still pass; low-conviction counter entries blocked.
 * Neutral 0.80: SIDEWAYS needs meaningful bonus (HTF/killzone) to pass threshold. */
export const REGIME_MULTIPLIERS = {
  aligned: 1.0,
  neutral: 0.80,
  counter: 0.25,
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

// ── In-memory candle retention ─────────────────────────────────────────────
// Keep a bounded "hot window" per coin|TF in RAM.
// Historical candles are persisted to PG (write-through), so retaining unbounded
// arrays in memory provides little value and will eventually overwhelm the host.
//
// Notes:
// - 1m is used for entry refinement only (no signal scan), so a smaller window is fine.
// - Larger TFs use wider windows for regime/structure context.
export const MAX_IN_MEMORY_CANDLES_BY_INTERVAL: Record<CandleInterval, number> = {
  '1m': 1_000,
  '5m': 2_000,
  '15m': 5_000,
  '1h': 5_000,
  '4h': 5_000,
  '1d': 5_000,
} as const

// Staleness: warn if no candle received in this many ms
export const STALENESS_THRESHOLD_MS = 60_000

// Staleness watchdog checks every N ms
export const STALENESS_CHECK_INTERVAL_MS = 30_000

// Status line printed every N ms
export const STATUS_INTERVAL_MS = 60_000

// ATR multiplier for zone proximity buffer (confirm layer)
export const ZONE_BUFFER_ATR_MULT = 0.3

// ATR multiplier for wick-based SL buffer (trigger layer)
// Tuned from 0.3→0.5: original too tight (wick hunt), 0.8 too wide (killed R:R).
export const SL_WICK_ATR_MULT = 0.5

// Volume profile lookback window for confirm layer
export const VP_LOOKBACK = 100

// Volume profile bins — computed as priceRange / numBins
export const VP_BINS = 50

// Value area percentage for volume profile (70% = standard)
export const VP_VALUE_AREA_PCT = 0.7

// Pattern TTL in bars (how long a setup stays active before expiring)
export const PATTERN_TTL_BARS: Record<string, number> = {
  'smc-sd': 12,
}

// ─── SMC+S&D Zone Bounce Strategy ────────────────────────────────────────────

/** How many bars back to look for a BOS/CHoCH to establish direction. */
export const SMC_BREAK_LOOKBACK = 20

/** Timeframes to skip for SMC-SD strategy.
 * 5m re-enabled: TP now targets 1h structure (context.htfCandles via HTF_MAP['5m']='1h')
 * instead of 4h. 5m SL (0.5 ATR) + 1h TP (1-3%) = R:R 2-6x, WR target 35-40%.
 * Previous failure: tight 5m SL + distant 4h TP required WR >90% — unachievable. */
export const SMC_SD_SKIP_INTERVALS: ReadonlyArray<string> = []

/** Coins to skip for SMC-SD strategy (configurable per-exchange blacklist).
 * Empty by default — configure based on backtest results per exchange.
 * Historical underperformers (0% WR on HL P2b): DOGE, LINK, AVAX.
 * Reason: high-noise meme/DeFi coins with erratic wicks defeat zone-bounce logic. */
export const SMC_COIN_BLACKLIST: ReadonlyArray<string> = []

/** Minimum bars between signals on same coin/interval (dedup).
 * Reduced from 15 to 8: was too restrictive, missing valid re-entries at zones. */
export const SMC_DEDUP_BARS = 8

/** ATR multiplier for structural price comparison tolerance (cross-exchange robustness). */
export const SMC_PRICE_TOLERANCE_ATR_MULT = 0.02

/** Minimum candle body/range ratio for valid bounce (reject doji/indecision candles).
 * Reduced from 0.3 to 0.25: allow pin bars with slightly smaller bodies. */
export const SMC_MIN_BODY_RATIO = 0.25

/** Minimum zone strength score to qualify for bounce detection.
 * Raised 0.35→0.50: raw demand/supply zones with strength 0.35-0.49 had high
 * false-break rate (formed from 1-2 pivots, untested). 0.50 filters single-test
 * zones while breaker blocks (0.85) and inversion FVGs (0.75) still qualify. */
export const SMC_MIN_ZONE_STRENGTH = 0.50

/** Minimum reward:risk ratio — skip trades with R:R below this.
 * Kept at 2.0 (P1): wider SL (1.0 ATR from P0) already raised effective quality.
 * 2.3 combined with neutral 0.80 killed 95% of signals — too aggressive.
 * 2.0R with 45% WR = profitable. Quality comes from regime+HTF filters, not R:R floor. */
export const SMC_MIN_RR = 2.0

// ─── ICT Model Enhancements ─────────────────────────────────────────────────

/** Enable HTF structure alignment check (ICT top-down analysis).
 * SOFT mode: HTF alignment adds confidence bonus, opposing HTF still blocks.
 * Hard reject only when HTF opposes with >0.6 confidence. */
export const SMC_ICT_HTF_ALIGNMENT = true

/** Enable OTE (Optimal Trade Entry) zone filter.
 * SOFT: OTE adds confidence bonus, does NOT reject non-OTE entries.
 * Backtest showed strict OTE filter kills too many valid entries. */
export const SMC_ICT_OTE_FILTER = true

/** Minimum displacement body/ATR ratio for bounce confirmation.
 * Lowered from 0.5 to 0.3: crypto wicks often have smaller bodies.
 * Displacement is a BONUS, not a requirement — standard wick entries still work. */
export const SMC_ICT_DISPLACEMENT_BODY_ATR = 0.3

/** Require liquidity sweep for through-zone entries (ICT stop hunt model).
 * Disabled: through-zone alone is a strong signal. Sweep is a bonus.
 * Was killing 50%+ of through-zone entries. */
export const SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH = false

/** Confidence bonus for HTF-aligned trades. */
export const SMC_ICT_HTF_ALIGNED_BONUS = 0.10

/** Confidence penalty when HTF bias opposes signal direction (P1).
 * Targets counter-HTF longs in bear: 0.65 - 0.10 = 0.55 × 0.75 = 0.4125 → BLOCKED.
 * Symmetric: also penalizes shorts in strong bull HTF bias. */
export const SMC_ICT_HTF_COUNTER_PENALTY = 0.10

/** Confidence bonus for OTE zone entries. */
export const SMC_ICT_OTE_BONUS = 0.08

/** Confidence bonus for liquidity pool proximity (BSL/SSL near TP). */
export const SMC_ICT_LIQUIDITY_POOL_TP_BONUS = 0.05

// ─── ICT Crypto Killzones ────────────────────────────────────────────────────
// Adapted from ICT forex killzones to 24/7 crypto markets.
// Crypto volume concentrates around TradFi session opens.
// Trading OUTSIDE killzones has lower volume = more fakeouts.

/** Enable killzone time filter. When true, signals outside killzones get confidence penalty. */
export const SMC_ICT_KILLZONE_ENABLED = true

/** Killzone definitions: [startHourUTC, endHourUTC].
 * Crypto adaption of ICT sessions:
 * - Asian session: accumulation / range building
 * - London open: first real move (smart money enters)
 * - US open / London-US overlap: highest volume, strongest moves
 * - Asian close / pre-London: often sets the day's high or low */
export const SMC_ICT_KILLZONES: ReadonlyArray<{ name: string; startUTC: number; endUTC: number; bonus: number }> = [
  { name: 'london-open', startUTC: 7, endUTC: 10, bonus: 0.08 },     // London open: high-probability
  { name: 'us-overlap', startUTC: 13, endUTC: 16, bonus: 0.10 },    // London/US overlap: highest vol
  { name: 'us-session', startUTC: 16, endUTC: 20, bonus: 0.05 },    // US afternoon: continuation
  { name: 'asia-open', startUTC: 0, endUTC: 3, bonus: 0.03 },      // Asia: lower vol but sets lows
] as const

/** Confidence penalty for signals OUTSIDE any killzone.
 * Reduced from 0.08→0.04: was blocking all 15m signals when combined with HTF penalty. */
export const SMC_ICT_KILLZONE_PENALTY = 0.04

// ─── ICT Breaker Block + Inversion FVG ──────────────────────────────────────

/** Enable Breaker Block detection (OB broken → flips to opposition zone). */
export const SMC_ICT_BREAKER_BLOCK_ENABLED = true

/** Confidence bonus when price reacts at a Breaker Block (strong level). */
export const SMC_ICT_BREAKER_BLOCK_BONUS = 0.08

/** Enable Inversion FVG (FVG completely filled → flips type, becomes new zone). */
export const SMC_ICT_INVERSION_FVG_ENABLED = true

/** Confidence bonus when price reacts at an Inversion FVG. */
export const SMC_ICT_INVERSION_FVG_BONUS = 0.06

// ─── ICT Multi-TF Drill-Down (4h → 15m) ────────────────────────────────────

/** POI time-to-live in ms. 80 hours = 20 × 4h bars. */
export const SMC_HTF_POI_TTL_MS = 80 * 3_600_000

/** 15m bars to look back for confirming CHoCH/BOS at POI. */
export const SMC_LTF_CHOCH_LOOKBACK = 5

/** Bars after CHoCH to look for entry FVG. */
export const SMC_LTF_ENTRY_FVG_LOOKBACK = 3

/** Min R:R for drill-down entries (higher floor — wide 4h TP expected). */
export const SMC_DRILLDOWN_MIN_RR = 3.0

/** ATR buffer for 15m structure stop (tighter than 1h's 0.7). */
export const SMC_DRILLDOWN_SL_ATR_BUFFER = 0.5

/** Base confidence for drill-down signals (HTF alignment guaranteed). */
export const SMC_DRILLDOWN_CONFIDENCE_BASE = 0.70

/** Bonus if 15m confirmation is CHoCH (reversal > continuation). */
export const SMC_DRILLDOWN_CHOCH_BONUS = 0.10

/** Max POIs stored per coin to prevent memory growth. */
export const SMC_DRILLDOWN_MAX_POIS = 10

/** Confirmed POI TTL in ms. Raised 1h→1.5h: 15m CHoCH can happen near bar end,
 * giving only 30-45min for 5m FVG to appear — too short. 1.5h = 18 bars on 5m.
 * Conservative increase (was 4h → 96% SL rate, so not reverting far). */
export const SMC_CONFIRMED_POI_TTL_MS = 4 * 3_600_000

/** Max confirmed POIs per coin. */
export const SMC_CONFIRMED_POI_MAX = 5

// ─── 4h Swing Signals ────────────────────────────────────────────────────────
// 4h previously only registered HTF POIs without emitting signals.
// Enabling adds direct swing entries when price bounces at 4h demand/supply zone.
// SL is wider (1.0 ATR) and TP uses 4h structure swing targets.

/** Enable 4h same-TF swing signal emission at zone bounce. */
export const SMC_4H_SWING_ENABLED = true

/** ATR buffer for 4h swing stop — wider than scalp to absorb daily noise. */
export const SMC_4H_SWING_SL_ATR_BUFFER = 1.0

/** Min R:R for 4h swing entries. */
export const SMC_4H_SWING_MIN_RR = 2.0

/** Base confidence for 4h swing signals (fresh 4h BOS/CHoCH + zone bounce). */
export const SMC_4H_SWING_CONFIDENCE_BASE = 0.68

// ─── 15m Scalp Signals ───────────────────────────────────────────────────────
// 15m previously only confirmed 4h POIs (no signal output).
// Enabling emits a scalp signal immediately on CHoCH at 4h POI —
// tighter entry than waiting for 5m FVG. TP: 15m structure targets (~1-3%).

/** Enable 15m scalp signal when CHoCH confirmed at 4h HTF POI. */
export const SMC_15M_SCALP_ENABLED = true

/** ATR buffer for 15m scalp stop (15m swing structure). */
export const SMC_15M_SCALP_SL_ATR_BUFFER = 0.5

/** Min R:R for 15m scalp entries. */
export const SMC_15M_SCALP_MIN_RR = 2.0

/** Base confidence for 15m scalp (4h POI + 15m CHoCH = dual TF confirmation). */
export const SMC_15M_SCALP_CONFIDENCE_BASE = 0.68

// ─── ICT 5m Micro-Entry ─────────────────────────────────────────────────────

/** 5m bars to look for FVG entry after confirmed POI. */
export const SMC_5M_FVG_LOOKBACK = 10

/** ATR buffer for 5m swing stop.
 * Raised 0.3→0.5: 0.3 ATR on BTC ≈ $150 buffer — crypto wick noise + spread
 * (~$15) meant SL was hunted on normal retest before real move. 0.5 gives
 * enough room; min R:R adjusted down accordingly. */
export const SMC_5M_SL_ATR_BUFFER = 0.5

/** Min R:R for 5m micro-entry. Reduced 3.5→2.5: TP now targets 1h structure
 * (context.htfCandles), not 4h. 5m SL (0.5 ATR) + 1h TP (1-3%) = R:R 2-6x.
 * Original 3.5 was calibrated for 4h TP (~5-20%) which required WR >90%. */
export const SMC_5M_MIN_RR = 2.5

/** Base confidence for 5m micro-entry (HTF + LTF confirmed = highest confidence). */
export const SMC_5M_CONFIDENCE_BASE = 0.75

/** Minimum SL distance % for 5m micro-entry.
 * SL < 0.4% on 5m is pure noise — crypto spread (~0.05%) + normal 5m wick (~0.2%)
 * means SL is hit before any directional move. Reject ultra-tight stops. */
export const SMC_5M_MIN_SL_PCT = 0.004

/** Require 15m CHoCH confirmation for 5m micro-entry.
 * 5m FVG alone at 4h POI has ~22% WR. Adding 15m CHoCH requirement ensures
 * lower-timeframe structure has shifted before micro-entry. The confirmedPOI
 * already has ltfBreakKind from the 15m scan — use it as a hard gate. */
export const SMC_5M_REQUIRE_15M_CHOCH = false

// ─── ICT AMD (Power of Three) ───────────────────────────────────────────────

/** Enable AMD session mode. Scans for Judas Swing at session opens.
 * DISABLED: 21% WR on backtest — Judas detection too loose for crypto 24/7.
 * Needs: tighter range criteria, volume confirmation, stricter reversal check.
 * Re-enable after tuning with longer dataset. */
export const SMC_AMD_ENABLED = false

/** Accumulation session: Asia (crypto adaptation).
 * Range builds during low-volume Asia hours. */
export const SMC_AMD_ACCUMULATION_START_UTC = 0
export const SMC_AMD_ACCUMULATION_END_UTC = 7

/** Manipulation windows: session opens where Judas Swings occur.
 * Each window: [startHourUTC, endHourUTC, name]. */
export const SMC_AMD_MANIPULATION_WINDOWS: ReadonlyArray<{ start: number; end: number; name: string }> = [
  { start: 7, end: 10, name: 'london-open' },   // London open — primary Judas Swing
  { start: 13, end: 16, name: 'us-open' },       // US open — secondary Judas Swing
] as const

/** Min R:R for AMD entries (tight SL after Judas reversal). */
export const SMC_AMD_MIN_RR = 2.5

/** Base confidence for AMD entries (Judas confirmed = high probability). */
export const SMC_AMD_CONFIDENCE_BASE = 0.72

/** Confidence bonus for Judas Swing detection. */
export const SMC_AMD_JUDAS_BONUS = 0.10

/** ATR buffer for SL beyond Judas sweep wick. */
export const SMC_AMD_SL_ATR_BUFFER = 0.3

/** AMD runs on 15m candles (enough resolution to detect Judas + entry). */
export const SMC_AMD_INTERVAL: CandleInterval = '15m'

/** Min bars in accumulation range (too few = unreliable range). */
export const SMC_AMD_MIN_RANGE_BARS = 5

// ─── P2: Liquidation Cascade Filter ─────────────────────────────────────────
// Perp liquidation cascades produce sharp wicks + huge volume that look like
// ICT manipulation but are forced-selling artifacts. Detect and discount.

/** Volume ratio threshold above which a candle is considered a potential cascade.
 * 3.0 = volume is 3× the 20-bar average — extreme spike, not normal absorption. */
export const SMC_LIQUIDATION_VOLUME_RATIO = 3.0

/** Wick-to-ATR ratio threshold. If intra-candle range > N × ATR, likely cascade.
 * 3.0 ATR wick on a single bar = abnormal in normal markets, common in liquidations. */
export const SMC_LIQUIDATION_WICK_ATR_MULT = 3.0

/** Confidence multiplier applied when cascade detected. 0.4 = heavy discount;
 * not 0.0 (sometimes cascade creates valid entry after the flush completes). */
export const SMC_LIQUIDATION_CONFIDENCE_MULT = 0.4

// ─── scan1hSameTF Quality Filters (Eng Review 2026-04-12) ──────────────────
/** BOS confidence penalty — BOS is continuation, lower conviction than CHoCH reversal. */
export const SMC_1H_BOS_PENALTY = 0.15
/** Minimum volume ratio (vs 20-bar avg) to accept 1H signal. Below = low-conviction noise. */
export const SMC_1H_MIN_VOLUME_RATIO = 0.7
/** Minimum ADX for 1H signal. Raised 18→20: trending filter was too loose. */
export const SMC_1H_MIN_ADX = 20
/** Core coin allowlist for 1H same-TF mode.
 * Walk-forward OOS shows edge concentration on top-tier liquidity coins.
 * Empty array disables this gate. */
export const SMC_1H_ALLOWED_COINS = ['BTC', 'ETH', 'SOL'] as const

// ─── P2: Weekend Volume Filter ───────────────────────────────────────────────
// Crypto volume Fri-Sun = 30-50% of weekday. Low-volume BOS/CHoCH has higher
// false-break rate because thin books allow easier manipulation.

/** Volume ratio below which weekend candles are considered low-volume.
 * 0.6 = current volume is 60% below the 20-bar average → suspicious. */
export const SMC_WEEKEND_VOLUME_RATIO_THRESHOLD = 0.6

/** Confidence multiplier on low-volume weekend bars. 0.7 = 30% penalty.
 * Not 0.0 — genuine setups can still form on weekends, just less reliable. */
export const SMC_WEEKEND_CONFIDENCE_MULT = 0.7

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

/**
 * Fraction of account equity at risk per position (e.g. 0.02 = 2%).
 * Env: `RISK_PER_POSITION` — decimal between 0 and 1. Unset → 0.02.
 */
function parseRiskPerPositionFraction(): number {
  const raw = process.env.RISK_PER_POSITION
  const fallback = 0.02
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(
      'RISK_PER_POSITION must be a decimal fraction between 0 and 1 (e.g. 0.02 for 2% of account per position).'
    )
  }
  return n
}

const RISK_PER_POSITION_FRACTION = parseRiskPerPositionFraction()

/** Same as {@link RISK_PER_POSITION_FRACTION} — used for sizing and portfolio estimates. */
export const DEFAULT_RISK_PERCENT = RISK_PER_POSITION_FRACTION

/** Risk limits for position sizing and drawdown protection. */
export const RISK = {
  /** Max risk per trade as fraction of account (see env `RISK_PER_POSITION`). */
  maxRiskPerTrade: RISK_PER_POSITION_FRACTION,
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
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
} as const

/**
 * Watchlist/status refresh cadence by timeframe.
 * Setup detection still runs on every closed candle; only status recomputation is throttled.
 */
export const STATUS_UPDATE_EVERY_BARS: Record<CandleInterval, number> = {
  '1m': 6,
  '5m': 3,
  '15m': 2,
  '1h': 1,
  '4h': 1,
  '1d': 1,
} as const

// ─── Pipeline Benchmark CI Budget ─────────────────────────────────────────

export type PipelineBenchmarkMetricMode = 'raw' | 'robust'

export const PIPELINE_BENCH_CI_BASELINE_PATH = 'results/baselines/pipeline-benchmark-baseline.json'

export const PIPELINE_BENCH_CI_COINS = [
  'BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'ARB', 'APT', 'BNB', 'DOT', 'ATOM',
] as const

export const PIPELINE_BENCH_CI_TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const satisfies readonly CandleInterval[]

export const PIPELINE_BENCH_CI_BARS_PER_SERIES = 1_200
export const PIPELINE_BENCH_CI_WARMUP_RUNS = 2
export const PIPELINE_BENCH_CI_MEASURED_RUNS = 9
export const PIPELINE_BENCH_CI_TRIM_RATIO = 0.01

/** Compare robust metrics by default to reduce CI flakes from scheduler/GC spikes. */
export const PIPELINE_BENCH_CI_METRIC_MODE: PipelineBenchmarkMetricMode = 'robust'

/** Max allowed regression vs baseline before CI fails.
 * Keep p95 strict, but allow more p99 headroom on hosted GitHub runners
 * where tail latency shows materially higher scheduler variance. */
export const PIPELINE_BENCH_CI_MAX_REGRESSION = {
  p95Pct: 0.10,
  p99Pct: 0.25,
} as const

// ─── Max Holding Period (P0 fix) ──────────────────────────────────────────

/** Maximum bars to hold a position per TF before force-closing at market.
 * Prevents zombie positions that lock capital for weeks.
 * Backtest showed 5m trades held 1000-12000 bars (3-43 days), 1h held 500-2000 bars.
 * These limits ensure capital turnover:
 *   5m: 200 bars = ~17h (disabled anyway, but for future)
 *   15m: 120 bars = 30h
 *   1h: 72 bars = 3 days (48 tested — killed trailing stop winners)
 *   4h: 30 bars = 5 days
 *   1d: 15 bars = 15 days */
export const MAX_HOLDING_BARS: Record<string, number> = {
  '1m': 300,
  '5m': 200,
  '15m': 120,
  '1h': 72,
  '4h': 30,
  '1d': 15,
}

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
  'meme': ['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME', 'MYRO', 'BRETT'],
  'ai': ['FET', 'AGIX', 'OCEAN', 'RENDER', 'TAO', 'AKT', 'AR', 'NEAR'],
  'defi': ['AAVE', 'UNI', 'MKR', 'CRV', 'COMP', 'DYDX', 'SNX', 'SUSHI'],
  'l1': ['AVAX', 'DOT', 'ATOM', 'ADA', 'NEAR', 'SUI', 'APT', 'SEI', 'TIA', 'INJ'],
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

/** ATR stop multipliers by trade style. */
export const ATR_STOP_MULTIPLIER = {
  tight: 1.0,     // scalping / day trade
  standard: 1.5,  // swing trade — recommended default
  wide: 2.0,      // position trade
  veryWide: 2.5,  // volatile crypto / weekly
} as const

/** ATR buffer added below structure stop (Section 12.2 Method 1).
 * Raised 0.7→1.0: backtest shows 1h SL hit 44% (HL) / 44% (Bybit) with 0.7.
 * Crypto wicks routinely sweep 0.7 ATR past structure — 1.0 gives breathing room.
 * R:R impact offset by fewer SL hits (higher WR). */
export const STRUCTURE_STOP_ATR_BUFFER = 1.0

/** Maximum stop distance as fraction of entry price. Beyond this → skip.
 * Used by exits.ts (order lifecycle). */
export const MAX_STOP_DISTANCE_PCT = 0.10

/** Maximum SL distance % for strategy signal emission. Reject trades with SL > this.
 * Applied in SMC-SD scan — prevents oversized 4h ATR stops. */
export const MAX_TRADE_SL_PCT = 0.07

/** Maximum leverage warning threshold. */
export const MAX_LEVERAGE_WARN = 5.0

/**
 * Target margin per position as fraction of account equity (default 10%).
 * Used to compute setLeverage before order placement (HL may cap leverage at asset max).
 * leverage = ceil(sizeUsd / (accountValue × TARGET_MARGIN_PCT))
 * Position **size** is not reduced to fit this budget — risk-based sizing only.
 */
export const TARGET_MARGIN_PCT = 0.10

/** Hyperliquid minimum order notional (USD). See exchange-service validation. */
export const HL_MIN_ORDER_NOTIONAL_USD = 10

/**
 * Market order slippage buffer used when submitting HL "FrontendMarket" (IOC-like) orders.
 *
 * HL market orders are encoded as aggressive limits with a reference price; if the reference
 * price is stale (e.g. derived from candles) the order can be rejected with
 * "IOC not able to match". We mitigate by taking the latest L2 mid (if available) and
 * applying a small buffer:
 * - long (buy): mid × (1 + buffer)
 * - short (sell): mid × (1 - buffer)
 */
export const MARKET_ORDER_SLIPPAGE_PCT = 0.01  // 1%

/** Trailing stop config defaults.
 * activationPct raised 0.01→0.03: +1% in crypto happens within minutes then reverts,
 * activating trail too early → locked in at low profit. Now needs +3% confirmation.
 * trailPct raised 0.005→0.01: 0.5% trail hit by normal 0.3-0.7% retests, missing
 * extended runs (3R→10R). 1% gives room for pullback while still capturing trend. */
export const TRAILING_STOP = {
  activationPct: 0.03,  // activate trailing after +3% profit (was 1% — too early)
  trailPct: 0.01,       // trail 1% below highest price (was 0.5% — too tight)
} as const

/** Partial close config defaults.
 * firstTpRatio raised 1.0→1.5: closing at 1R then moving SL to breakeven was
 * killing expectancy — crypto spread+slippage (~0.06%) means breakeven SL gets
 * hit on any 0.1% retest. Now close at 1.5R for cushion.
 * moveSlToBreakeven disabled: remaining 50% needs air room to run to full TP. */
export const PARTIAL_CLOSE = {
  firstTpRatio: 1.5,    // first TP at 1.5R (was 1R — too easy to hit SL after)
  firstClosePct: 0.5,   // close 50% at first TP
  moveSlToBreakeven: false,  // disabled: breakeven SL hit by spread+retest
  secondTpRatio: 3.0,   // second TP at 3R (remainder rides full target)
} as const

/** Active thesis monitor: re-evaluate trade thesis during open position.
 * Checks if multi-TF regime/bias alignment that justified entry still holds.
 * Deterioration score 0.0 (fully aligned) → 1.0 (fully opposed).
 * HTF flips weighted 2x entry TF — a 4h regime flip matters more than a 5m flip. */
export const THESIS_MONITOR = {
  enabled: true,
  /** Minimum ms between thesis checks = entry TF duration × this multiplier. */
  cooldownMultiplier: 1.0,
  /** HTF weight relative to entry TF (higher = HTF flips matter more). */
  htfWeight: 2.0,
  /** Score below this = aligned, no action. */
  minorThreshold: 0.3,
  /** Score at or above this → move SL to breakeven. */
  moderateThreshold: 0.5,
  /** Score at or above this → close position immediately. */
  severeThreshold: 0.8,
} as const

/** Timeframes to monitor for thesis per entry TF.
 * Each entry TF checks itself + its HTF chain (via HTF_MAP). */
export function getThesisMonitorTFs(entryTf: CandleInterval): CandleInterval[] {
  const tfs: CandleInterval[] = [entryTf]
  let current = entryTf
  while (true) {
    const htf = HTF_MAP[current]
    if (htf === current || tfs.includes(htf)) break
    tfs.push(htf)
    current = htf
  }
  return tfs
}

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

/** Position split across 3 TP levels: TP1 (zone), TP2 (swing), TP3 (trail).
 * P2 rebalance: TP2 only hit 9% of partial closes (6/67 on Bybit) — 35% allocation
 * sat idle. Shifted weight to TP1 which fires most often. Trail kept at 40%
 * (primary profit engine: +$4,247 from 11 trades on HL). */
export const MULTI_TP_SPLIT = [0.35, 0.25, 0.40] as const

/** Minimum R:R for TP1. TP1 must be at least this far from entry.
 * Raised from 1.5 to 2.0: ensures winning trades cover at least 2 losses. */
export const MIN_TP1_RR = 2.0

/** Activate trailing stop after price moves this many R in profit.
 * Reduced from 1.0 to 0.5R: trailing now activates sooner to protect gains. */
export const TRAIL_ACTIVATION_R = 0.5

// ─── Backtest (Sprint 3A) ──────────────────────────────────────────────────

/** Max months of history allowed for browser-triggered backtest (OOM guard). */
export const MAX_BACKTEST_MONTHS = 6

/** Bars between async yield points in browser backtest (keep event loop responsive). */
export const BACKTEST_CHUNK_SIZE = 100

/** Default slippage for backtest fills (0.05% = 5 bps). */
export const BACKTEST_SLIPPAGE_PCT = 0.0005

/** Default commission per trade for backtest (0.03% = 3 bps, HL taker fee). */
export const BACKTEST_COMMISSION_PCT = 0.0003

/** Max concurrent open positions in backtest.
 * Live trading uses RISK.maxConcurrentPositions (3). Backtest allows 5 to test
 * diversification benefit across 50 coins × 4 TFs, while preventing the unlimited
 * position count that inflated MaxDD to 200%. */
export const BACKTEST_MAX_OPEN_POSITIONS = 5

/** Risk per trade for backtest as fraction of current equity.
 * Lower than live (2%) because backtest has no circuit breaker recovery pause.
 * 1.5% × 5 max positions = 7.5% total account risk — survivable. */
export const BACKTEST_RISK_PER_TRADE_PCT = 0.015

/** Circuit breaker drawdown threshold for backtest.
 * If currentEquity drops below initialCapital × (1 - threshold), skip new entries.
 * Simulates the live CIRCUIT_BREAKER.maxDrawdownLimit but for full backtest run. */
export const BACKTEST_CIRCUIT_BREAKER_DD = 0.15

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

// ─── Canonical Strategy ─────────────────────────────────────────────────────

/** Runtime is single-strategy; this label is metadata only, not a routing key. */
export const CANONICAL_STRATEGY_ID = 'smc-sd' as const

// ─── Portfolio Risk (Sprint 4.5 S6) ─────────────────────────────────────────

/** Portfolio-level risk limits for the shared runtime account. */
export const PORTFOLIO_RISK = {
  /** Max total notional exposure as multiple of total account equity. */
  maxTotalExposure: 3.0,
  /** Max total concurrent positions across the whole runtime. */
  maxTotalConcurrent: 6,
} as const

// ─── Paper Trade Mode ─────────────────────────────────────────────────────────

/** Paper trade mode: simulate fills instead of calling HL exchange. */
export const PAPER_TRADE = process.env.PAPER_TRADE === 'true'

/** Runtime override from Telegram (null = use env {@link PAPER_TRADE}). */
let paperTradeRuntimeOverride: boolean | null = null

/** Effective paper mode: runtime override when set, otherwise env default. */
export function getEffectivePaperTrade(): boolean {
  return paperTradeRuntimeOverride !== null ? paperTradeRuntimeOverride : PAPER_TRADE
}

/**
 * Set paper mode at runtime (Telegram). Pass `null` to clear override and follow env again.
 * Switching live↔paper mid-session can desync open positions — use with care.
 */
export function setPaperTradeRuntimeOverride(value: boolean | null): void {
  paperTradeRuntimeOverride = value
}

/** Current runtime override (null = follow env). Exposed for Telegram /status. */
export function getPaperTradeRuntimeOverride(): boolean | null {
  return paperTradeRuntimeOverride
}

/** Test helper: reset runtime paper override. */
export function resetPaperTradeRuntimeOverrideForTests(): void {
  paperTradeRuntimeOverride = null
}

/** Slippage applied to paper fills (0.05% = 5 bps). */
export const PAPER_SLIPPAGE_PCT = 0.0005

/** Default starting balance (USD) for the single paper wallet. */
export const PAPER_DEFAULT_BALANCE = 100

/** Initial USD balance for the canonical paper wallet. */
export function getPaperInitialBalance(): number {
  const raw = process.env['PAPER_BALANCE_SMC_SD']
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  return PAPER_DEFAULT_BALANCE
}

// ─── Order Lifecycle (S6) ────────────────────────────────────────────────────

/** Order fill timeout (ms) — cancel entry if not filled. */
export const ORDER_FILL_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes

/** Max open orders per coin (enforces 1-position-per-coin rule). */
export const MAX_ORDERS_PER_COIN = 1

/** SL trigger order type: market (guaranteed fill on stop). */
export const SL_IS_MARKET = true

/** TP trigger order type: market (guaranteed fill on target hit). */
export const TP_IS_MARKET = true

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
  /**
   * IANA timezone for morning/evening daily reports (journal stats use local calendar day).
   * Default UTC. Example: `Asia/Ho_Chi_Minh`.
   */
  reportTimezone: process.env.TELEGRAM_REPORT_TZ?.trim() || 'UTC',
  /** Set `TELEGRAM_DAY_REPORTS=false` to disable scheduled morning/evening summaries. */
  dayReportsEnabled: process.env.TELEGRAM_DAY_REPORTS !== 'false',
  /** Debounce window for briefing refresh edits (ms). */
  briefingRefreshDebounceMs: 2_000,
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

// ── Multi-exchange ─────────────────────────────────────────────────────────

/**
 * Returns the active exchange from ACTIVE_EXCHANGE env.
 * Throws at startup if not set or invalid — no silent defaults.
 */
export function getActiveExchange(): ExchangeId {
  const raw = process.env['ACTIVE_EXCHANGE']
  if (!raw) throw new Error('ACTIVE_EXCHANGE env is required. Set to HL or BB.')
  if (raw !== 'HL' && raw !== 'BB') throw new Error(`Unknown ACTIVE_EXCHANGE: "${raw}". Valid values: HL, BB`)
  return raw
}

/**
 * Best-effort exchange lookup for tests, scripts, and backward-compat runtime paths.
 * Returns null when ACTIVE_EXCHANGE is missing or invalid instead of throwing.
 */
export function tryGetActiveExchange(): ExchangeId | null {
  const raw = process.env['ACTIVE_EXCHANGE']
  if (raw === 'HL' || raw === 'BB') return raw
  return null
}

// ── Bybit-specific config ──────────────────────────────────────────────────

/** Bybit candle interval format (maps CandleInterval → Bybit API string). */
export const BYBIT_INTERVAL_MAP: Record<CandleInterval, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
}

/** Max candles per single Bybit REST request. */
export const BYBIT_BACKFILL_BATCH_SIZE = 1000

/**
 * Total candles to fetch per TF during Bybit backfill.
 * Matches HL counts — BYBIT_BACKFILL_BATCH_SIZE=1000 is per-request,
 * the batch walker makes multiple requests to reach these totals.
 * Small TFs: 500 (recent data sufficient for entry refinement).
 * Large TFs: 5000 (full history needed for regime/structure detection).
 */
export const BYBIT_BACKFILL_CANDLE_COUNTS: Record<string, number> = {
  '1m': 500,
  '5m': 500,
  '15m': 5000,
  '1h': 5000,
  '4h': 5000,
  '1d': 5000,
}

/** Bybit rate limit: token bucket. 120 req/10s burst. */
export const BYBIT_REST_BURST_TOKENS = 120
/** Bybit rate limit: refill interval ms (1 token per 100ms = 10/s sustained). */
export const BYBIT_REST_REFILL_MS = 100
/** Bybit execution (trading) rate limit: burst tokens. Conservative vs 10/s UID limit. */
export const BYBIT_EXEC_BURST_TOKENS = 10
/** Bybit execution rate limit: refill interval ms (1 token per 100ms = 10/s sustained). */
export const BYBIT_EXEC_REFILL_MS = 100

/** Bybit funding rate refresh interval ms. Funding settles every 8h — 4h refresh is sufficient. */
export const BYBIT_FUNDING_REFRESH_MS = 4 * 60 * 60 * 1000


// ── Exchange coin registry ─────────────────────────────────────────────────

/**
 * Number of top Bybit coins by OI to track (dynamic selection via tickers API).
 * Higher than HL native (20) — Bybit rate limits are ~30x more permissive.
 */
export const BYBIT_TOP_COINS_LIMIT = 80

/** Minimum 24h turnover (USDT) to qualify for Bybit coin tracking. */
export const BYBIT_MIN_24H_VOLUME = 1_000_000

/**
 * Fallback static coin list for Bybit — used only if dynamic fetch fails at startup.
 * HL coins are dynamic (fetchTopCoins by OI at runtime) — no static list needed.
 */
export const BYBIT_STATIC_COINS: string[] = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
  'MATIC', 'UNI', 'ATOM', 'LTC', 'BCH', 'FIL', 'NEAR', 'APT', 'ARB', 'OP',
]

/** Coins available on both HL and Bybit (for cross-exchange comparison). */
export const COMMON_COINS: string[] = [
  'BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'DOT', 'UNI', 'ATOM', 'APT', 'ARB',
]

/**
 * Get fallback coin list for an exchange (used when dynamic fetch fails at startup).
 * HL: returns empty (populated at runtime by fetchTopCoins).
 * BB: returns BYBIT_STATIC_COINS.
 */
export function getDefaultCoins(exchange: ExchangeId): string[] {
  if (exchange === 'BB') return BYBIT_STATIC_COINS
  return []
}

/** Max concurrent REST backfill requests for Bybit. */
export const BYBIT_BACKFILL_CONCURRENCY = 3

// ─── Parameter Optimizer Schema (Evolution Phase 1) ──────────────────────

/** Parameter search space for optimizer random sampling.
 * Each field maps to a StrategyParams key with min/max/step bounds.
 * Optimizer generates random values within these bounds, steps optional.
 * Params: MIN_CONFIDENCE, REGIME_MULT_COUNTER, REGIME_MULT_NEUTRAL,
 *   SMC_DRILLDOWN_CONFIDENCE_BASE (15m scan base), SL_WICK_ATR_MULT,
 *   SMC_MIN_RR, SMC_1H_CONFIDENCE_BASE (1h scan base). */
export const PARAM_SCHEMA = {
  MIN_CONFIDENCE: { min: 0.40, max: 0.80, step: 0.05, type: 'float' as const },
  REGIME_MULT_COUNTER: { min: 0.10, max: 0.50, step: 0.05, type: 'float' as const },
  REGIME_MULT_NEUTRAL: { min: 0.60, max: 1.00, step: 0.05, type: 'float' as const },
  SMC_DRILLDOWN_CONFIDENCE_BASE: { min: 0.50, max: 0.80, step: 0.05, type: 'float' as const },
  SL_WICK_ATR_MULT: { min: 0.3, max: 1.0, step: 0.1, type: 'float' as const },
  SMC_MIN_RR: { min: 1.5, max: 4.0, step: 0.5, type: 'float' as const },
  SMC_1H_CONFIDENCE_BASE: { min: 0.50, max: 0.75, step: 0.05, type: 'float' as const },
} as const

/** Optimizer: fraction of trials selected as holdout-validation candidates. */
export const OPTIMIZER_CANDIDATE_FRACTION = 0.20
/** Optimizer: lower bound for number of holdout candidates. */
export const OPTIMIZER_CANDIDATE_MIN = 10
/** Optimizer: upper bound for number of holdout candidates. */
export const OPTIMIZER_CANDIDATE_MAX = 40
/** Optimizer candidate scoring: target OOS trades before trade-factor saturates. */
export const OPTIMIZER_SELECTION_OOS_TRADE_TARGET = 40
/** Optimizer final objective: minimum holdout PF considered robust. */
export const OPTIMIZER_HOLDOUT_MIN_PF = 1.1
/** Optimizer final objective: minimum holdout trades considered robust. */
export const OPTIMIZER_HOLDOUT_MIN_TRADES = 40
/** Optimizer final objective: target holdout trades before trade-factor saturates. */
export const OPTIMIZER_HOLDOUT_TRADE_TARGET = 40
