# Minh (明) — Domain Knowledge Specification

> Archive note (2026-04-15): research/reference spec only. The live runtime currently implements one concrete `smc-sd` setup engine and does not treat this file as executable architecture.

Complete detect / validate / invalidate rules for all trading schools used by Minh.
For domain understanding (philosophy, concepts, pros/cons), see [`domain-knowledge.md`](../ref/domain-knowledge.md).
Tue source reference: `~/Downloads/Personal/gettueapp/src/entities/hanh/features/research/indicators/`.

---

# Part 1: Trading Schools

Each school is self-contained — describes what it is, what it detects, and how patterns invalidate.

---

## Wyckoff Method

Richard D. Wyckoff (early 20th century). Market is driven by the "Composite Man" — aggregate of institutional players. Read their behavior through price and volume across 4 market phases.

3 Wyckoff Laws: Supply & Demand, Cause & Effect, Effort vs Result.

### Phase Detection

```
detectWyckoffPhase(candles, idx, rangePeriod=20, trendPeriod=50):

  atrRatio = ATR(rangePeriod) / ATR(trendPeriod)
    < 0.7 → range tightening (accumulation or distribution)
    > 1.2 → range expanding (markup or markdown)

  trendSlope = (SMA(trendPeriod, now) - SMA(trendPeriod, 20 bars ago)) / SMA
    < -0.02 → prior downtrend
    > +0.02 → prior uptrend

  volumeContext:
    volRatio < 0.8 → declining volume (isVolumeDecreasing)
    volRatio > 2.0 → volume spike (isVolumeSpike)
```

### 4 Phases

| Phase | Detect | Base Confidence | Boosters |
|-------|--------|-----------------|----------|
| **Accumulation** | atrRatio < 0.7 AND trendSlope < -0.02 | 0.6 | +0.15 declining volume, +0.20 Spring detected |
| **Markup** | atrRatio > 1.2 AND trendSlope > +0.02 | 0.7 | +0.15 volume spike |
| **Distribution** | atrRatio < 0.7 AND trendSlope > +0.02 | 0.6 | +0.15 declining volume, +0.20 UTAD detected |
| **Markdown** | atrRatio > 1.2 AND trendSlope < -0.02 | 0.7 | +0.15 volume spike |

### Wyckoff Events

```
Spring (false breakdown):
  In accumulation phase
  candle.low < rangeLow(20 bars)     ← pierces below support
  candle.close > rangeLow            ← closes back inside
  → Bullish signal (shakeout before markup)

  Invalidation: close below springLow × 0.99 (spring failed)
  TTL = 15 bars

UTAD (Upthrust After Distribution):
  In distribution phase
  candle.high > rangeHigh(20 bars)   ← pierces above resistance
  candle.close < rangeHigh           ← closes back inside
  → Bearish signal (trap before markdown)

  Invalidation: close above UTAD high (real breakout)
  TTL = 15 bars
```

### Effort vs Result (Wyckoff Law 3)

```
effortVsResult(candles, idx, lookback=20, threshold=2.0):
  volRatio > threshold AND priceChange/ATR < 0.3
  → High effort (volume) with no result (price movement) = hidden activity

  Direction:
    downtrend + bullish close → bullish (hidden accumulation)
    uptrend + bearish close  → bearish (hidden distribution)
```

---

## Smart Money Concepts (SMC/ICT)

Michael Huddleston (ICT — Inner Circle Trader). "Smart money" (banks, funds, market makers) manipulates price to grab retail liquidity. Trader reads their footprints.

Shares deep DNA with Wyckoff — same phenomena, different terminology.

### Fair Value Gap (FVG)

```
Detect (3-candle pattern):
  Bullish FVG: candle[i].low > candle[i-2].high  (gap up)
    Zone: [candle[i-2].high (bottom), candle[i].low (top)]
  Bearish FVG: candle[i].high < candle[i-2].low  (gap down)
    Zone: [candle[i].high (bottom), candle[i-2].low (top)]

Filled (Consequent Encroachment):
  midpoint = (top + bottom) / 2
  Bullish filled: candle.low ≤ midpoint
  Bearish filled: candle.high ≥ midpoint

scanFVGs(): detect all → mark filled → return only unfilled

Invalidation: FVG fully filled. TTL = 10 bars.
```

### Order Block (OB)

```
Detect:
  For each candle i (lookback=50):
    impulse = next candle body ≥ 1.5× current body

    Bullish OB: bearish candle (close < open) + bullish impulse next
      Zone: [candle.low, candle.open]
    Bearish OB: bullish candle (close > open) + bearish impulse next
      Zone: [candle.open, candle.high]

  Fresh: price hasn't retested zone yet
    Tested: candle.low touches bullish OB zone, or candle.high touches bearish OB zone

Invalidation:
  Long: close below OB low
  Short: close above OB high
  TTL = 20 bars.
```

### Swing Points

```
findSwingPoints(candles, upToIdx, lookback=3):
  For each candle i in [lookback .. upToIdx - lookback]:
    isHigh = candle[i].high > candle[i-j].high AND candle[i].high > candle[i+j].high
             for ALL j in [1..lookback]
    isLow  = candle[i].low < candle[i-j].low AND candle[i].low < candle[i+j].low
             for ALL j in [1..lookback]

  Returns SwingPoint[] sorted by index
```

### BOS / CHoCH (Structure Breaks)

```
Track swing highs and swing lows separately.

BOS (Break of Structure) = continuation:
  Bullish BOS: close > previous swing high, in existing uptrend
  Bearish BOS: close < previous swing low, in existing downtrend

CHoCH (Change of Character) = reversal:
  Bullish CHoCH: close > previous swing high, in existing downtrend
  Bearish CHoCH: close < previous swing low, in existing uptrend

Invalidation:
  Long: retrace 0.5% below break level
  Short: retrace 0.5% above break level
  TTL = 5 bars.
```

### Liquidity Sweep

```
Detect (lookback=20, wickRatio=0.6):
  Find recentLow / recentHigh over lookback bars

  Bullish sweep:
    candle.low < recentLow                    (pierces below)
    AND candle.close > recentLow              (closes back above)
    AND lowerWick / range > wickRatio         (wick dominant)

  Bearish sweep:
    candle.high > recentHigh
    AND candle.close < recentHigh
    AND upperWick / range > wickRatio

Invalidation: new structure break in sweep direction. TTL = 8 bars.
```

### Premium / Discount Zone

```
Given a swing range [swing_low, swing_high]:
  equilibrium = (swing_high + swing_low) / 2    (Fibonacci 50%)
  Premium zone: price > equilibrium             (should sell / short)
  Discount zone: price < equilibrium            (should buy / long)

Usage: Only take longs in discount, shorts in premium.
```

### Optimal Trade Entry (OTE)

```
Given a swing [A, B] (impulse move):
  OTE zone = Fibonacci 62% to 79% retracement of AB

  For bullish OTE (after bullish impulse A→B where B > A):
    OTE top    = B - (B - A) × 0.62
    OTE bottom = B - (B - A) × 0.79

  For bearish OTE (after bearish impulse A→B where B < A):
    OTE top    = B + (A - B) × 0.79
    OTE bottom = B + (A - B) × 0.62

Usage: Highest probability entry zone for continuation trades.
```

---

## Price Action

Pure price reading — no indicators needed. The oldest school. Al Brooks, Nial Fuller, Lance Beggs.

Two roles in Minh:
- **Structure reading**: Swing classification (HH/HL/LH/LL) + structural bias
- **Trigger candles**: 12 candlestick patterns as entry confirmation

### Helpers

```
spread(c) = c.h - c.l
body(c)   = |c.c - c.o|
isBullish(c) = c.c > c.o
isBearish(c) = c.c < c.o
lowerWick(c) = min(c.o, c.c) - c.l
upperWick(c) = c.h - max(c.o, c.c)
bodyTop(c) = max(c.o, c.c)
bodyBottom(c) = min(c.o, c.c)

trendDirection(candles, idx, lookback):
  change = candles[idx].c - candles[idx - lookback].c
  atrVal = ATR(candles, idx, lookback)
  if change > atrVal × 0.5 → 'up'
  if change < -atrVal × 0.5 → 'down'
  else → 'flat'
```

### Swing Classification

```
classifySwings(candles, upToIdx, lookback=3):
  raw = findSwingPoints(candles, upToIdx, lookback)
  For each swing, compare to previous swing of SAME type:

  High swings:
    price > lastHigh → HH (Higher High)
    price < lastHigh → LH (Lower High)
    first or equal   → EH (Equal High)

  Low swings:
    price > lastLow → HL (Higher Low)
    price < lastLow → LL (Lower Low)
    first or equal  → EL (Equal Low)
```

### Structural Bias

```
detectStructuralBias(swings):
  Requires ≥ 4 swings. Analyze last 10.

  bullishCount = count(HH + HL)
  bearishCount = count(LH + LL)
  total = bullishCount + bearishCount

  bullishRatio ≥ 0.60 → bias = 'bullish', confidence = bullishRatio
  bearishRatio ≥ 0.60 → bias = 'bearish', confidence = bearishRatio
  else → bias = 'neutral'

  trendSince: walk backward to find first opposing swing
```

### Single-Candle Patterns

| # | Pattern | Detect | Direction | Strength |
|---|---------|--------|-----------|----------|
| 1 | **Doji** | body < 10% spread | neutral | 0.4 fixed |
| 2 | **Dragonfly Doji** | body < 10% spread, lowerWick > 60% spread, upperWick < 10% | bullish | min(lowerWick/ATR, 1.0) |
| 3 | **Gravestone Doji** | body < 10% spread, upperWick > 60% spread, lowerWick < 10% | bearish | min(upperWick/ATR, 1.0) |
| 4 | **Pin Bar (Bull)** | lowerWick > 60% spread, body < 30%, upperWick < 20%, trend ≠ up | bullish | min(lowerWick/ATR, 1.0) |
| 5 | **Pin Bar (Bear)** | upperWick > 60% spread, body < 30%, lowerWick < 20%, trend ≠ down | bearish | min(upperWick/ATR, 1.0) |
| 6 | **Hammer** | bullish candle, lowerWick ≥ 2×body, upperWick < 0.5×body, trend = down | bullish | min(lowerWick/ATR, 1.0) |
| 7 | **Shooting Star** | bearish candle, upperWick ≥ 2×body, lowerWick < 0.5×body, trend = up | bearish | min(upperWick/ATR, 1.0) |

Detection priority: Doji first (mutually exclusive with pin bar/hammer).

### Multi-Candle Patterns

| # | Pattern | Detect | Direction | Strength |
|---|---------|--------|-----------|----------|
| 8 | **Bullish Engulfing** | prev bearish, curr bullish, curr body engulfs prev body (bodyBottom < prev, bodyTop > prev) | bullish | min(engulfRatio/3, 1.0) where engulfRatio = body(curr)/body(prev) |
| 9 | **Bearish Engulfing** | prev bullish, curr bearish, curr body engulfs prev body | bearish | min(engulfRatio/3, 1.0) |
| 10 | **Tweezer Top** | prev.high ≈ curr.high (within 5% ATR), prev bullish, curr bearish | bearish | 0.6 fixed |
| 11 | **Tweezer Bottom** | prev.low ≈ curr.low (within 5% ATR), prev bearish, curr bullish | bullish | 0.6 fixed |
| 12a | **Inside Bar** | curr.high ≤ prev.high AND curr.low ≥ prev.low | candle color | 0.5 fixed |
| 12b | **Outside Bar** | curr.high > prev.high AND curr.low < prev.low | candle color | 0.7 fixed |

### Invalidation

All PA patterns: **TTL = 6 bars**. Invalid if close beyond pattern extreme in opposite direction.

---

## Supply & Demand

Sam Seiden (Online Trading Academy). Price moves due to supply/demand imbalance. Identify strong zones on chart and trade when price returns. Closely related to SMC but focuses on zone compilation, merge, and strength ranking rather than individual OB/FVG patterns.

### Key Zone Compilation

```
compileKeyZones(candles, upToIdx):

  Sources:
    1. Order Blocks (detectOrderBlocks, lookback=50)
       bullish OB → demand zone
       bearish OB → supply zone

    2. Swing Levels (classifySwings)
       low swings → demand zone [price, price + ATR×0.3]
       high swings → supply zone [price - ATR×0.3, price]

    3. Active FVGs (scanFVGs)
       bullish FVG → demand zone
       bearish FVG → supply zone

  Merge: overlapping zones within ATR × 0.5
    Expand: high = max, low = min
    Combine sources (multi-confluence)

  Touch counting:
    demand: candle.low touches zone → touch++
    supply: candle.high touches zone → touch++
    Broken: close through zone → fresh = false

  Strength ranking:
    sourceScore(0.4) × min(sources.length/3, 1)
    + recencyScore(0.25) × (lastTouch/upToIdx)
    + touchScore(0.25) × {2+: 0.8, 1: 0.5, 0: 0.3}
    + freshBonus(0.1) × (fresh ? 0.2 : 0)

  Sort by proximity to current price. Max 8 per side.
```

### Concepts

| Concept | Definition |
|---------|-----------|
| **Demand Zone** | Area where buying pressure exceeded selling, creating strong upward move |
| **Supply Zone** | Area where selling pressure exceeded buying, creating strong downward move |
| **Fresh Zone** | Zone not yet retested — highest probability of reaction |
| **Origin of Move** | The base candle(s) before an explosive move |

### Invalidation

Demand zone: close below zone bottom. Supply zone: close above zone top. **TTL = 25 bars.**

### Full Structure Analysis

```
analyzeStructure(candles, upToIdx):
  Returns MarketStructure {
    bias, biasConfidence,
    swings: ClassifiedSwing[],
    demandZones: KeyZone[], supplyZones: KeyZone[],
    nearestDemand, nearestSupply,
    currentPrice, regime
  }

  Requires upToIdx ≥ 49 (else returns neutral defaults)
```

---

## Volume Spread Analysis (VSA)

Tom Williams, building on Wyckoff. The relationship between spread (candle range) and volume reveals "big boys" intent — are they accumulating or distributing?

### Context Metrics

```
volRatio = current volume / SMA(volume, 20)
spreadRatio = (high - low) / ATR(20)
bodyRatio = body / spread
trendChange = candles[idx].close - candles[idx - 20].close
```

### Bullish Signals

| # | Signal | Detect | Meaning | Strength |
|---|--------|--------|---------|----------|
| 1 | **Stopping Volume** | volRatio > 2.5 AND spreadRatio > 1.2 AND bearish AND downtrend | Selling climax, institutional buying | min(volRatio/4, 1.0) |
| 2 | **Test** | volRatio < 0.5 AND spreadRatio < 0.6 AND lowerWick > body AND downtrend | Testing supply — absent → rally | min((1-volRatio)×0.8, 1.0) |
| 3 | **No Supply** | volRatio < 0.4 AND spreadRatio < 0.5 AND bullish close AND downtrend | Supply exhausted | min((1-volRatio)×0.7, 1.0) |
| 4 | **Bag Holding** | volRatio > 3.0 AND spreadRatio > 1.0 AND bullish AND bodyRatio > 0.6 | Smart money absorbing selling | min(volRatio/5, 1.0) |

### Bearish Signals

| # | Signal | Detect | Meaning | Strength |
|---|--------|--------|---------|----------|
| 5 | **Buying Climax** | volRatio > 2.5 AND spreadRatio > 1.2 AND bullish AND uptrend | FOMO buying into distribution | min(volRatio/4, 1.0) |
| 6 | **Upthrust** | volRatio > 1.5 AND upperWick > 2×body AND bearish | False breakout, selling into strength | min(volRatio/3, 1.0) |
| 7 | **No Demand** | volRatio < 0.4 AND spreadRatio < 0.5 AND bearish AND uptrend | Demand dried up | min((1-volRatio)×0.7, 1.0) |

### Neutral (Confluence)

| # | Signal | Detect | Meaning | Direction |
|---|--------|--------|---------|-----------|
| 8 | **Effort vs Result** | volRatio > 2.0 AND spreadRatio < 0.4 | High volume, no price change = divergence | downtrend + bullish close → bullish; uptrend + bearish close → bearish |

### Invalidation

All VSA signals: invalid if close beyond SL price. **TTL = 8 bars.**

---

## Order Flow (Volume Profile)

Subset of Order Flow analysis (DOM, Footprint, Delta, Cumulative Delta, Market Profile, Volume Profile). Volume Profile is the only Order Flow tool computable from OHLCV candles without L2 order book data.

### Build Profile

```
buildVolumeProfile(candles, startIdx, endIdx, numBins=50, valueAreaPct=0.70):

  1. Find price range [priceLow, priceHigh]
  2. Create bins (binSize = range / numBins, center = priceLow + binSize × (i + 0.5))
  3. For each candle:
     - lowBin = floor((candle.low - priceLow) / binSize)
     - highBin = floor((candle.high - priceLow) / binSize)
     - volPerBin = candle.volume / (highBin - lowBin + 1)
     - Distribute evenly across bins
     - Bullish candle → buyVolume, Bearish → sellVolume
  4. POC = bin with max volume (priceLevel)
  5. Value Area: expand from POC (alternate up/down) until 70% total volume
     - VAH = upper boundary, VAL = lower boundary
  6. HVN: local maxima > 1.5× average volume
  7. LVN: contiguous zones < 0.5× average, return center of each
```

### Concepts

| Concept | Definition | Trading Use |
|---------|-----------|-------------|
| **POC** | Highest volume price level | Major S/R, price gravitates here |
| **VAH** | Upper 70% volume boundary | Resistance below, support above |
| **VAL** | Lower 70% volume boundary | Support above, resistance below |
| **HVN** | Volume spike zones | Consolidation areas, strong S/R |
| **LVN** | Volume dry zones | Fast move-through, low acceptance |

### Entry Signals

- **Long**: price near VAL with POC above → entry at VAL, TP at POC
- **Short**: price near VAH with POC below → entry at VAH, TP at POC
- **Invalidation**: close beyond VA boundary in wrong direction. **TTL = 12 bars.**

---

## Indicator-Based

Mathematical formulas computed on price/volume data to generate quantitative signals. The most common school for beginners. Not a bias tool — an environmental measurement tool.

Minh uses indicators specifically for **regime classification**, not for entry signals.

### Regime Detection

```
detectRegime(candles, idx):
  Requires idx ≥ 49 (else returns SIDEWAYS)

  SMA(7)/SMA(30) ratio → trend direction
  ATR(7)/ATR(30) ratio → volatility spike (>1.8 → VOLATILE)
  ADX(14)              → trend strength (<20 → SIDEWAYS)
  volumeTrend(10)      → confirmation

  Decision tree:
    ATR ratio > 1.8                           → VOLATILE
    ADX < 20                                  → SIDEWAYS
    SMA ratio > 1.01 + (ADX>30 OR ratio>1.02 OR volTrend>0.1) → BULL
    SMA ratio < 0.99 + (ADX>30 OR ratio<0.98 OR volTrend>0.1) → BEAR
    else                                      → SIDEWAYS

  Priority: VOLATILE > SIDEWAYS > BULL/BEAR
```

### Regime Multipliers

```
Signal aligned with regime (Long+BULL, Short+BEAR):  ×1.0
Signal in neutral regime (SIDEWAYS, VOLATILE):        ×0.8
Signal counter regime (Long+BEAR, Short+BULL):        ×0.3

Threshold: confidence ≥ 0.4 after multiplication
```

### Important Note

Indicator-based regime can **lag** at inflection points. When Wyckoff says Distribution but indicators still say BULL — the indicators are behind. This is why regime is a confidence modulator, not a gate.

---

# Part 2: Layered Decision Framework

How the 7 schools work together. This is Minh's chosen combo — a hybrid of the two most effective combinations for Crypto trading.

## Combo

Minh combines:

**Combo 1: SMC + Price Action + Order Flow** — most popular for Crypto/Forex.
SMC provides bias and zones. PA provides trigger. Order Flow provides volume confirmation.

**Combo 2: Wyckoff + VSA + Supply & Demand** — strongest theoretical foundation.
Wyckoff provides macro phase. VSA confirms volume behavior. S&D identifies zones.

Result: **7 schools operating across 5 layers + regime context.**

## Workflow

```
Layer 1 — BIAS           ← Wyckoff (phase) + SMC (BOS/CHoCH)
  "What is smart money doing?"
  Wyckoff phase tells accumulation/distribution cycle.
  SMC structure breaks tell trend continuation or reversal.
  Output: bias = long | short | neutral
  If neutral → STOP

Layer 2 — STRUCTURE       ← Price Action (HH/HL/LH/LL, structural bias)
  "Does price structure confirm the bias?"
  classifySwings + detectStructuralBias.
  If structure contradicts bias → STOP or downgrade.

Layer 3 — ZONE            ← SMC (OB/FVG) + Supply & Demand (key zones)
  "Where to enter?"
  Only search zones matching bias direction.
  compileKeyZones: OB + FVG + swing pivots → merge, rank, max 8 per side.
  If no zone near current price → WAIT

Layer 4 — VOLUME CONFIRM  ← VSA (8 signals) + Order Flow (Volume Profile)
  "Is there volume backing this zone?"
  VSA: stopping volume, test, no supply at demand zone → confirmed.
  VP: zone overlaps HVN/POC → boosted. Zone overlaps LVN → penalized.
  No volume signal → zone is weaker but not dropped.

Layer 5 — TRIGGER          ← Price Action (12 candlestick patterns)
  "Is there a confirmation candle at the zone?"
  Engulfing, pin bar, hammer at zone → trigger.
  No PA pattern at zone → wait for next candle.

Regime Context (parallel)  ← Indicator-Based (SMA/ATR/ADX/volume)
  detectRegime → BULL/BEAR/SIDEWAYS/VOLATILE
  Modulates confidence (×1.0 / ×0.8 / ×0.3). Does NOT gate.
  Warns when lagging behind Wyckoff phase.
```

Each layer can **STOP early** — no compute wasted on lower layers when upper layers say "no trade".

## Confluence Scoring

Count how many layers agree:

| Confluence | Grade | Action |
|---|---|---|
| 1-2 factors | C-grade | Skip |
| 3-4 factors | B-grade | Alert (standard) |
| 5-6 factors | A-grade | Alert (high confidence) |
| 7 factors | A+ grade | Alert (maximum conviction) |

Factors counted:
1. Layer 1 bias clear (Wyckoff + SMC agree)
2. Layer 2 structure confirms
3. Layer 3 zone found (multi-source)
4. Layer 4 VSA confirms
5. Layer 4 VP/Order Flow confirms
6. Layer 5 PA trigger candle
7. Regime aligned

## Rules for Combining Schools (Section 9.6)

1. **Confirmation ≠ Redundancy.** Layers must come from DIFFERENT perspectives. Price + volume + structure = confirmation. RSI + Stochastic + CCI = redundancy (all momentum oscillators, same perspective).

2. **Higher Timeframe always wins.** When HTF and LTF conflict, trust HTF. Daily bias > 1H bias > 5m bias.

3. **Confluence requirements adapt to market conditions.** Strong trending market → 2-3 factors enough. Ranging/choppy market → need 5+ factors.

4. **Avoid analysis paralysis.** 2-3 core methods + 1-2 supporting is sufficient. More leads to indecision.

5. **Minh's core methods: SMC + Wyckoff. Supporting: PA, VSA, Volume Profile, Indicator-Based.**

## Cross-school DNA Map

Most TA schools share common ancestry from Wyckoff. Same phenomena, different terminology:

| Market Phenomenon | Wyckoff | SMC/ICT | Price Action | VSA |
|---|---|---|---|---|
| Institutional buying | Accumulation | Order Block | Support zone | Stopping Volume |
| Institutional selling | Distribution | Supply zone | Resistance zone | Climactic Action |
| False breakdown trap | Spring | Liquidity Sweep | False breakout | No Supply test |
| False breakout trap | Upthrust | Liquidity Grab | Bull trap | Upthrust on high vol |
| Reversal confirmation | Sign of Strength | Change of Character | Trend reversal | Effort vs Result |
| Key price area | Trading Range | Order Block / FVG | S/R level | High Volume Node |

**Fibonacci — the thread across schools:**
- SMC: Premium/Discount (Fib 50%), OTE (Fib 62-79%)
- Supply & Demand: pullback depth into zone
- When 3+ methods point to the same price via Fibonacci → extreme confluence

---

# Part 3: Reference

## Pattern TTL Summary

| Pattern Type | TTL (bars) | Invalidation Rule |
|---|---|---|
| order-block | 20 | Close beyond OB zone |
| fvg | 10 | FVG fully filled (CE) |
| spring | 15 | New low below spring × 0.99 |
| demand-zone | 25 | Close beyond swing/structure level |
| breakout | 5 | Retrace 0.5% beyond break level |
| vsa-signal | 8 | Close beyond SL |
| price-action | 6 | Close beyond pattern extreme |
| volume-profile | 12 | Close beyond VA boundary |

## Pattern Count by School

| School | Patterns/Signals | Total |
|--------|-----------------|-------|
| Wyckoff | 4 phases + Spring + UTAD + Effort vs Result | 7 |
| SMC | FVG, OB, BOS, CHoCH, Sweep, Premium/Discount, OTE | 7 |
| Price Action | 12 patterns (7 single + 5 multi) + swing classification + structural bias | 14 |
| Supply & Demand | Key zone compilation (demand + supply + merge + rank) | — |
| VSA | 4 bullish + 3 bearish + 1 neutral | 8 |
| Order Flow (VP) | POC, VAH, VAL, HVN, LVN | 5 |
| Indicator-Based | detectRegime (4 states) | 1 |
