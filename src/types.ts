// ─── Core data ────────────────────────────────────────────────────────────────

/** OHLCV candle with open timestamp. All prices as floats (parseFloat from HL strings). */
export interface Candle {
  t: number  // open timestamp ms
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

/** Supported exchange identifiers. */
export type ExchangeId = 'HL' | 'BB'

// ─── Regimes & bias ───────────────────────────────────────────────────────────

export type MarketRegime = 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE'
export type StructureBias = 'bullish' | 'bearish' | 'neutral'

// ─── Signals ──────────────────────────────────────────────────────────────────

export type SignalSide = 'long' | 'short'

export type PatternType = 'smc-sd'

export interface Signal {
  type: PatternType
  side: SignalSide
  confidence: number
  entryPrice: number
  slPrice: number
  tpPrice: number
  patternData: Record<string, unknown>
  confluenceGrade?: ConfluenceGrade
  confluenceCount?: number
}

export interface ActiveSetup extends Signal {
  id: string              // `${coin}|${tf}|${type}|${side}`
  coin: string
  interval: CandleInterval
  detectedAt: number      // timestamp ms
  detectedAtBar: number   // bar index when setup was created (for 0-bar skip)
  expiresAtBar: number    // bar index when detected + TTL
  /** Strategy that generated this setup. */
  strategyId?: string
  /** Exchange this signal came from — used by OrderManager to route to correct executor. */
  exchange: ExchangeId
}

// ─── Market structure ─────────────────────────────────────────────────────────

/** Raw pivot high/low point detected by findPivots(). */
export interface PivotPoint {
  kind: 'high' | 'low'
  price: number
  index: number
}

export interface StructureBreak {
  kind: 'bos' | 'choch'
  direction: 'bullish' | 'bearish'
  level: number
  index: number
}

export type SwingType = 'HH' | 'HL' | 'LH' | 'LL'

export interface SwingPoint {
  type: SwingType
  price: number
  index: number
}

export interface KeyZone {
  type: 'demand' | 'supply'
  top: number
  bottom: number
  strength: number  // 0–1
  origin: string    // e.g. 'order-block', 'fvg', 'swing'
  createdAtIdx: number  // candle index when zone was first detected
}

export interface MarketStructure {
  bias: StructureBias
  biasConfidence: number  // 0–1
  swings: SwingPoint[]
  demandZones: KeyZone[]
  supplyZones: KeyZone[]
}

// ─── Indicators ───────────────────────────────────────────────────────────────

export interface FVG {
  top: number
  bottom: number
  midpoint: number
  bullish: boolean
  index: number  // index of the third candle (candle that created the gap)
}

export interface OrderBlock {
  top: number
  bottom: number
  bullish: boolean
  index: number   // index of the OB candle
  tested: boolean // true once price has touched the zone
}

export type VSASignalType =
  | 'stopping-volume'
  | 'effort-vs-result'
  | 'no-demand'
  | 'no-supply'
  | 'climax-buy'
  | 'climax-sell'
  | 'test'
  | 'thrust'

export type WyckoffPhase = 'accumulation' | 'distribution' | 'markup' | 'markdown'

export type WyckoffEvent = 'spring' | 'utad'

export interface VolumeProfile {
  poc: number      // Price of Control (highest volume price)
  vah: number      // Value Area High (70% volume boundary)
  val: number      // Value Area Low (70% volume boundary)
  hvn: number[]   // High Volume Nodes
  lvn: number[]   // Low Volume Nodes
}

// ─── Order Flow (Phase B) ────────────────────────────────────────────────────

export interface FundingSnapshot {
  coin: string
  rate: number        // parseFloat from HL string
  premium: number     // parseFloat from HL string
  timestamp: number   // ms epoch
}

export interface DeltaState {
  delta: number       // net aggressive volume (buy - sell)
  cumDelta: number    // cumulative delta over N bars
  buyVol: number      // total buy volume
  sellVol: number     // total sell volume
  barTs: number       // bar open timestamp
}

export interface OrderBookSnapshot {
  coin: string
  bids: [number, number][]  // [price, size][] — top 20
  asks: [number, number][]  // [price, size][] — top 20
  imbalance: number         // (bidSize - askSize) / (bidSize + askSize)
  timestamp: number
}

// ─── Asset Context (Phase D) ────────────────────────────────────────────────

export interface AssetCtxSnapshot {
  coin: string
  openInterest: number   // total OI in USD
  markPrice: number
  oraclePrice: number
  funding: number        // current funding rate
  premium: number        // mark/oracle divergence
  timestamp: number      // ms epoch
}

// ─── Strategy Context (ICT Multi-TF) ─────────────────────────────────────────

/** Optional context passed to strategy scan() for multi-timeframe analysis. */
export interface StrategyContext {
  /** Higher-timeframe candles for HTF structure alignment (ICT top-down). */
  htfCandles?: Candle[]
  /** Higher-timeframe interval identifier. */
  htfInterval?: CandleInterval
}

// ─── Backfill ────────────────────────────────────────────────────────────────

/** Per-coin backfill result: how many TFs succeeded. */
export interface BackfillResult {
  coin: string
  readyTFs: number
}

// ─── Config / invalidation ────────────────────────────────────────────────────

export type InvalidationReason =
  | 'zone-broken'
  | 'fvg-filled'
  | 'spring-failed'
  | 'demand-lost'
  | 'breakout-failed'
  | 'sl-hit'
  | 'pattern-failed'
  | 'va-broken'
  | 'ttl-expired'

// ─── Confluence ──────────────────────────────────────────────────────────────

export type ConfluenceGrade = 'C' | 'B' | 'A' | 'A+'

// ─── Decision Trace (briefing / operator oversight) ───────────────────────

/** A decision trace captures a single strategy evaluation for briefing and oversight. */
export interface DecisionTrace {
  coin: string
  interval: string
  strategyId: string
  ts: number
  outcome: {
    action: string
    confidence: number
    summary: string
    positionId: string | null
    setupId: string | null
  }
  roles: {
    guardian?: { state: string; summary: string; actions: string[] }
    executor?: { state: string; summary: string }
    judge?: { verdict?: string }
  }
  timeline: Array<{
    actor: 'scanner' | 'judge' | 'executor' | 'guardian'
    summary: string
  }>
}
