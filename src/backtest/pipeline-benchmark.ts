import { SIGNAL_TIMEFRAMES, TIMEFRAME_MS } from "../config.js";
import type { Candle, CandleInterval } from "../types.js";

export const VALID_INTERVALS: readonly CandleInterval[] = [
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
];

export interface BenchmarkOptions {
  coins: string[];
  timeframes: CandleInterval[];
  barsPerSeries: number;
  warmupRuns: number;
  measuredRuns: number;
  outlierTrimRatio: number;
  outputPath: string | null;
  seed: number;
  saveResult: boolean;
}

export interface ReplayEvent {
  coin: string;
  interval: CandleInterval;
  candle: Candle;
}

export interface LatencyStats {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

const DEFAULT_COINS = ["BTC", "ETH", "SOL", "AVAX", "LINK"];
const DEFAULT_BARS_PER_SERIES = 1_200;
const DEFAULT_WARMUP_RUNS = 2;
const DEFAULT_MEASURED_RUNS = 9;
const DEFAULT_OUTLIER_TRIM_RATIO = 0.01;
const DEFAULT_SEED = 42;

export function parseBenchmarkArgs(argv: readonly string[]): BenchmarkOptions {
  const coinsArg = parseListArg(argv, "--coins");
  const tfArg = parseListArg(argv, "--tfs");

  const coins = coinsArg && coinsArg.length > 0 ? coinsArg : DEFAULT_COINS;
  const timeframes = parseTimeframes(tfArg);

  return {
    coins,
    timeframes,
    barsPerSeries: parsePositiveInt(argv, "--bars", DEFAULT_BARS_PER_SERIES),
    warmupRuns: parseNonNegativeInt(argv, "--warmup", DEFAULT_WARMUP_RUNS),
    measuredRuns: Math.max(
      1,
      parsePositiveInt(argv, "--runs", DEFAULT_MEASURED_RUNS),
    ),
    outlierTrimRatio: parseTrimRatio(
      argv,
      "--trim",
      DEFAULT_OUTLIER_TRIM_RATIO,
    ),
    outputPath:
      parseStringArg(argv, "--out") ?? parseStringArg(argv, "--output"),
    seed: parseIntWithDefault(argv, "--seed", DEFAULT_SEED),
    saveResult: argv.includes("--save"),
  };
}

export function generateSyntheticCandles(
  coins: readonly string[],
  timeframes: readonly CandleInterval[],
  barsPerSeries: number,
  seed: number,
): Map<string, Candle[]> {
  const map = new Map<string, Candle[]>();
  const rng = createSeededRng(seed);
  const startTimeMs = Date.UTC(2024, 0, 1, 0, 0, 0);

  for (let coinIdx = 0; coinIdx < coins.length; coinIdx++) {
    const coin = coins[coinIdx]!;

    for (let tfIdx = 0; tfIdx < timeframes.length; tfIdx++) {
      const interval = timeframes[tfIdx]!;
      const stepMs = TIMEFRAME_MS[interval];
      const candles: Candle[] = [];

      let price = 100 + coinIdx * 35 + tfIdx * 18;
      const volatility = 0.0012 + tfIdx * 0.00015;
      const trendBias = (coinIdx % 2 === 0 ? 1 : -1) * 0.00015;

      for (let i = 0; i < barsPerSeries; i++) {
        const open = price;

        const wave =
          Math.sin((i + coinIdx * 7) / (16 + tfIdx * 3)) * volatility +
          Math.cos((i + tfIdx * 11) / 27) * volatility * 0.6;
        const noise = (rng() - 0.5) * volatility * 2.4;
        const drift = wave + noise + trendBias;

        const close = Math.max(0.0001, open * (1 + drift));

        const wickUp = 0.0005 + Math.abs(rng() - 0.5) * 0.003;
        const wickDown = 0.0005 + Math.abs(rng() - 0.5) * 0.003;

        const high = Math.max(open, close) * (1 + wickUp);
        const lowRaw = Math.min(open, close) * (1 - wickDown);
        const low = Math.max(0.0001, lowRaw);

        const volumeBase = 700 + coinIdx * 130 + tfIdx * 95;
        const volumeCycle =
          1 +
          Math.abs(Math.sin(i / 13)) * 0.8 +
          Math.abs(Math.cos(i / 31)) * 0.4;
        const volumeNoise = 0.7 + rng() * 0.7;
        const volume = volumeBase * volumeCycle * volumeNoise;

        candles.push({
          t: startTimeMs + i * stepMs,
          o: open,
          h: high,
          l: low,
          c: close,
          v: volume,
        });

        price = close;
      }

      map.set(`${coin}|${interval}`, candles);
    }
  }

  return map;
}

export function buildReplayEvents(
  candles: ReadonlyMap<string, Candle[]>,
  coins: readonly string[],
  timeframes: readonly CandleInterval[],
): ReplayEvent[] {
  const events: ReplayEvent[] = [];

  for (const coin of coins) {
    for (const interval of timeframes) {
      const series = candles.get(`${coin}|${interval}`);
      if (!series) continue;
      for (const candle of series) {
        events.push({ coin, interval, candle });
      }
    }
  }

  const intervalOrder = new Map<CandleInterval, number>(
    VALID_INTERVALS.map((tf, idx) => [tf, idx]),
  );

  events.sort((a, b) => {
    const tDiff = a.candle.t - b.candle.t;
    if (tDiff !== 0) return tDiff;

    const tfDiff =
      (intervalOrder.get(a.interval) ?? 0) -
      (intervalOrder.get(b.interval) ?? 0);
    if (tfDiff !== 0) return tfDiff;

    return a.coin.localeCompare(b.coin);
  });

  return events;
}

export function summarizeLatency(samplesMs: readonly number[]): LatencyStats {
  if (samplesMs.length === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    };
  }

  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);

  return {
    count: sorted.length,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    meanMs: sum / sorted.length,
    p50Ms: quantileSorted(sorted, 0.5),
    p95Ms: quantileSorted(sorted, 0.95),
    p99Ms: quantileSorted(sorted, 0.99),
  };
}

export function quantileSorted(
  sortedAsc: readonly number[],
  q: number,
): number {
  if (sortedAsc.length === 0) return 0;
  if (q <= 0) return sortedAsc[0]!;
  if (q >= 1) return sortedAsc[sortedAsc.length - 1]!;

  const rank = (sortedAsc.length - 1) * q;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);

  if (lo === hi) return sortedAsc[lo]!;

  const weight = rank - lo;
  return sortedAsc[lo]! * (1 - weight) + sortedAsc[hi]! * weight;
}

/**
 * Symmetrically trim low/high tails to reduce jitter from scheduler/GC spikes.
 * trimRatio=0.01 drops 1% smallest and 1% largest samples.
 */
export function trimOutliers(
  samplesMs: readonly number[],
  trimRatio: number,
): number[] {
  if (samplesMs.length === 0) return [];
  if (!Number.isFinite(trimRatio) || trimRatio <= 0) return [...samplesMs];

  const boundedRatio = Math.min(trimRatio, 0.49);
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const trimEachTail = Math.floor(sorted.length * boundedRatio);
  if (trimEachTail === 0 || trimEachTail * 2 >= sorted.length) return sorted;

  return sorted.slice(trimEachTail, sorted.length - trimEachTail);
}

export function defaultSignalTimeframes(): CandleInterval[] {
  return [...SIGNAL_TIMEFRAMES];
}

function parseTimeframes(list: string[] | null): CandleInterval[] {
  if (!list || list.length === 0) return defaultSignalTimeframes();

  const valid = new Set<CandleInterval>();
  for (const raw of list) {
    if (isCandleInterval(raw)) valid.add(raw);
  }

  if (valid.size === 0) return defaultSignalTimeframes();
  return [...valid];
}

function isCandleInterval(v: string): v is CandleInterval {
  return (VALID_INTERVALS as readonly string[]).includes(v);
}

function parseListArg(argv: readonly string[], flag: string): string[] | null {
  const value = parseStringArg(argv, flag);
  if (value === null) return null;

  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseStringArg(argv: readonly string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;

  const raw = argv[idx + 1]?.trim();
  return raw.length > 0 ? raw : null;
}

function parsePositiveInt(
  argv: readonly string[],
  flag: string,
  fallback: number,
): number {
  const n = parseIntArg(argv, flag);
  if (n === null) return fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseNonNegativeInt(
  argv: readonly string[],
  flag: string,
  fallback: number,
): number {
  const n = parseIntArg(argv, flag);
  if (n === null) return fallback;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseIntWithDefault(
  argv: readonly string[],
  flag: string,
  fallback: number,
): number {
  const n = parseIntArg(argv, flag);
  if (n === null) return fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseTrimRatio(
  argv: readonly string[],
  flag: string,
  fallback: number,
): number {
  const n = parseNumberArg(argv, flag);
  if (n === null) return fallback;
  if (!Number.isFinite(n) || n < 0) return fallback;
  // Keep in [0, 0.20] so robust view is informative and never over-trims.
  return Math.min(n, 0.2);
}

function parseIntArg(argv: readonly string[], flag: string): number | null {
  const n = parseNumberArg(argv, flag);
  if (n === null) return null;
  return n;
}

function parseNumberArg(argv: readonly string[], flag: string): number | null {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;

  const raw = argv[idx + 1]!;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const out = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return out;
  };
}
