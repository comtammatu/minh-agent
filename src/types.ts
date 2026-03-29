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

// ─── Regimes & bias ───────────────────────────────────────────────────────────

export type MarketRegime = 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE'
export type StructureBias = 'bullish' | 'bearish' | 'neutral'

// ─── Signals ──────────────────────────────────────────────────────────────────

export type SignalSide = 'long' | 'short'

export type PatternType =
  | 'order-block'
  | 'fvg'
  | 'spring'
  | 'demand-zone'
  | 'breakout'
  | 'vsa-signal'
  | 'price-action'
  | 'volume-profile'

export interface Signal {
  type: PatternType
  side: SignalSide
  confidence: number
  entryPrice: number
  slPrice: number
  tpPrice: number
  patternData: Record<string, unknown>
  // Layered pipeline fields (optional, added by pipeline)
  biasSource?: string
  confluenceGrade?: ConfluenceGrade
  confluenceCount?: number
  zoneOrigin?: string
  riskAssessment?: RiskAssessment
}

export interface ActiveSetup extends Signal {
  id: string              // `${coin}:${tf}:${type}:${side}`
  coin: string
  interval: CandleInterval
  detectedAt: number      // timestamp ms
  expiresAtBar: number    // bar index when detected + TTL
}

// ─── Market structure ─────────────────────────────────────────────────────────

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

// ─── Layered Pipeline ────────────────────────────────────────────────────────

export interface BiasResult {
  bias: 'long' | 'short' | 'neutral'
  confidence: number
  source: string           // 'wyckoff+smc', 'wyckoff-only', etc.
  htfBias?: 'long' | 'short' | 'neutral'
}

export type StructureVerdict = 'confirm' | 'neutral' | 'deny'

export interface ZoneConfirmation {
  zone: KeyZone
  vsaBoost: number         // 0 to 0.20
  vpBoost: number          // -0.10 to 0.15
  deltaBoost?: number      // -0.10 to 0.15 (Phase B)
  bookBoost?: number       // -0.10 to 0.20 (Phase B)
  fundingBoost?: number    // 0 to 0.10 (Phase B)
  throughZone: boolean     // Spring/Sweep detected
  confirmed: boolean
}

export type ConfluenceGrade = 'C' | 'B' | 'A' | 'A+'

export interface RiskAssessment {
  tradeable: boolean
  reason?: string
  suggestedSize: 'full' | 'standard' | 'partial' | 'skip'
  minRR: number
  stopMethod: 'structure' | 'atr' | 'skip'
}
