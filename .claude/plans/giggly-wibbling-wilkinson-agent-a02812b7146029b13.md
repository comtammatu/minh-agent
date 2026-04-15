> Historical scratch-plan note (2026-04-15): this file is preserved as an ad hoc implementation memo from before the single-strategy cleanup. It may reference pre-cleanup paths such as `src/scanner/*`; do not treat it as the source of truth for the current runtime layout.

# Backtest Exit Strategy Overhaul — Implementation Plan

## Problem Summary

Current backtest uses fixed 2R TP (`trigger.ts:77`). All 5/5 trades hit SL because price oscillates in the 2-4% range before reversing to SL. Need structure-based multi-level TP, trailing stops, and partial closes.

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where to compute structure TP | **Option A: Inside trigger.ts** | `compileKeyZones` and `findPivots` are pure functions. trigger.ts already receives `candles` + `idx`. No plumbing changes to pipeline.ts. |
| Simulator redesign | **Option A: Expand OpenPosition** | Adding fields to the existing struct avoids a new class hierarchy. The exit logic is 3 checks (TP1/TP2/trailing) — not complex enough to justify ExitManager. |
| BacktestTrade reporting | **Option B: Single trade record with weighted avg + detail array** | Keeps metrics.ts aggregation simple. One trade per position, with partial close details embedded. |
| Trailing update mechanism | **Inline in checkBar** | checkBar already iterates per bar. Add trailing state update + check after SL/TP checks. |

---

## Step 1: Add new types and config constants

### File: `src/backtest/types.ts`

Add partial close detail and expand BacktestTrade:

```typescript
/** Detail of a single partial close event within a position. */
export interface PartialCloseDetail {
  level: 'tp1' | 'tp2' | 'trail'
  price: number           // fill price (after slippage)
  closePct: number        // fraction of original position closed (0.4, 0.3, 0.3)
  pnl: number             // PnL for this partial
  barIndex: number
  time: number            // ms timestamp
}
```

Expand `BacktestTrade`:
- Add `tp1Price: number` — structure-based TP1
- Add `tp2Price: number` — swing-based TP2
- Add `partialCloses: PartialCloseDetail[]` — ordered list of fills
- Add `weightedExitPrice: number` — volume-weighted average exit across partials
- Change `exitReason` union to add `'partial_complete'` (all 3 levels hit)
- Keep existing `tpPrice` as the TP1 price for backward compat (alias)

New exit reason union:
```typescript
exitReason: 'sl_hit' | 'tp_hit' | 'trail_stop' | 'invalidated' | 'end_of_data' | 'partial_complete'
```

### File: `src/config.ts`

Add new constants:

```typescript
/** ATR trailing multipliers per timeframe (TP3 trailing stop). */
export const ATR_TRAIL_MULTIPLIER: Record<string, number> = {
  '15m': 1.5,
  '1h': 2.0,
  '4h': 2.5,
} as const

/** Partial close allocation for multi-level exit. */
export const MULTI_EXIT_PARTIAL = {
  tp1Pct: 0.40,   // 40% at TP1
  tp2Pct: 0.30,   // 30% at TP2
  trailPct: 0.30,  // 30% trailing
} as const

/** Minimum R:R for TP1. TP1 must be >= this from entry. */
export const MIN_TP1_RR = 1.5

/** Fallback R multiples when structure targets unavailable. */
export const FALLBACK_TP1_R = 2.0
export const FALLBACK_TP2_R = 3.0
```

---

## Step 2: Compute structure-based TP targets in trigger.ts

### File: `src/scanner/layers/trigger.ts`

**New imports:**
```typescript
import { compileKeyZones } from '../../indicators/structure.js'
import { findPivots } from '../../indicators/smc.js'
import { atr } from '../../indicators/core.js'
import { MIN_TP1_RR, FALLBACK_TP1_R, FALLBACK_TP2_R } from '../../config.js'
```

**New pure function:** `computeStructureTargets`

```typescript
export interface StructureTargets {
  tp1Price: number   // nearest opposing zone or fallback 2R
  tp2Price: number   // nearest swing or fallback 3R
  tp1Source: 'zone' | 'fallback'
  tp2Source: 'swing' | 'fallback'
}

function computeStructureTargets(
  candles: Candle[],
  idx: number,
  side: 'long' | 'short',
  entry: number,
  sl: number,
): StructureTargets
```

Logic:
1. Call `compileKeyZones(candles, idx)` to get both demand and supply zones.
2. **TP1**: For longs, find nearest supply zone with `midPrice > entry`. For shorts, nearest demand zone with `midPrice < entry`. The TP1 price = zone bottom (for longs) or zone top (for shorts) — conservative edge of the zone.
3. Enforce minimum R:R: if `TP1_distance / risk < MIN_TP1_RR (1.5)`, fall back to `entry + risk * FALLBACK_TP1_R`.
4. **TP2**: Call `findPivots(candles, idx, 3)`. For longs, find nearest pivot high with `price > tp1Price`. For shorts, nearest pivot low with `price < tp1Price`. Must be beyond TP1.
5. If no qualifying pivot found, fallback `entry + risk * FALLBACK_TP2_R`.
6. Return `StructureTargets`.

**Modify `findTrigger` return value:**

The `Signal` type has `tpPrice: number`. We need to pass multi-level targets. Two options:
- Option A: Add `tp1Price`, `tp2Price` to `Signal.patternData` (bag of unknowns — works but untyped).
- Option B: Extend `Signal` interface with optional `tp1Price?`, `tp2Price?`.

**Recommend Option B**: Add optional fields to `Signal` in `types.ts`:
```typescript
export interface Signal {
  // ... existing fields ...
  tp1Price?: number   // structure-based TP1
  tp2Price?: number   // swing-based TP2
}
```

Then in `findTrigger`, after computing SL:
```typescript
const targets = computeStructureTargets(candles, idx, side, entry, sl)
// tpPrice stays as TP1 for backward compat (single-TP consumers)
tp = targets.tp1Price

return {
  // ... existing fields ...
  tpPrice: tp,
  tp1Price: targets.tp1Price,
  tp2Price: targets.tp2Price,
  patternData: {
    // ... existing fields ...
    tp1Source: targets.tp1Source,
    tp2Source: targets.tp2Source,
  },
}
```

**ActiveSetup** inherits from Signal, so `tp1Price` and `tp2Price` flow through automatically.

---

## Step 3: Redesign simulator for multi-level exits

### File: `src/backtest/simulator.ts`

**Expand OpenPosition:**

```typescript
interface OpenPosition {
  coin: string
  setup: ActiveSetup
  side: SignalSide
  entryPrice: number
  slPrice: number
  currentSlPrice: number    // NEW: tracks SL moves (breakeven after TP1)
  tp1Price: number          // NEW: structure TP1
  tp2Price: number          // NEW: swing TP2
  sizeUsd: number           // original full size
  remainingSizePct: number  // NEW: 1.0 → 0.6 → 0.3 → 0.0
  entryTime: number
  entryBarIndex: number
  interval: CandleInterval  // NEW: needed for ATR trail multiplier lookup
  
  // Partial close tracking
  tp1Hit: boolean           // NEW
  tp2Hit: boolean           // NEW
  partialCloses: PartialCloseDetail[]  // NEW
  
  // Trailing state
  trailingState: TrailingStopState | null  // NEW: from exits.ts type
}
```

**Modify `tryFill()`:**

Extract `tp1Price` and `tp2Price` from setup (falling back to `tpPrice` and `tpPrice * 1.5` if not present for backward compat):

```typescript
tryFill(setup: ActiveSetup, barIndex: number): boolean {
  // ... existing one-position-per-coin check ...
  // ... existing slippage + sizing ...

  const tp1 = setup.tp1Price ?? setup.tpPrice
  const tp2 = setup.tp2Price ?? setup.tpPrice * 1.5

  this.positions.set(setup.coin, {
    // ... existing fields ...
    currentSlPrice: slPrice,
    tp1Price: tp1,
    tp2Price: tp2,
    remainingSizePct: 1.0,
    tp1Hit: false,
    tp2Hit: false,
    partialCloses: [],
    trailingState: null,
    interval: setup.interval,
  })
  return true
}
```

**Redesign `checkBar()`:**

New check order per bar:
1. **SL check** (on `currentSlPrice`, not original `slPrice`) — if hit, close remaining position.
2. **TP1 check** (if not yet hit) — if hit, execute 40% partial close, move SL to breakeven, activate trailing.
3. **TP2 check** (if TP1 hit and TP2 not yet hit) — if hit, execute 30% partial close.
4. **Trailing update** (if TP1 hit) — update trailing state with candle high/close. Check trailing stop hit on remaining 30%.

```typescript
checkBar(coin: string, candle: Candle, barIndex: number): void {
  const pos = this.positions.get(coin)
  if (!pos || pos.remainingSizePct <= 0) return

  // 1. SL on current (possibly breakeven) stop
  if (this.isSLHit(pos, candle, pos.currentSlPrice)) {
    this.closeRemaining(pos, pos.currentSlPrice, barIndex, candle.t, 'sl_hit')
    return
  }

  // 2. TP1 partial (40%)
  if (!pos.tp1Hit && this.isLevelHit(pos, candle, pos.tp1Price)) {
    this.executePartialClose(pos, 'tp1', pos.tp1Price, MULTI_EXIT_PARTIAL.tp1Pct, barIndex, candle.t)
    pos.tp1Hit = true
    pos.currentSlPrice = pos.entryPrice  // move SL to breakeven
  }

  // 3. TP2 partial (30%)
  if (pos.tp1Hit && !pos.tp2Hit && this.isLevelHit(pos, candle, pos.tp2Price)) {
    this.executePartialClose(pos, 'tp2', pos.tp2Price, MULTI_EXIT_PARTIAL.tp2Pct, barIndex, candle.t)
    pos.tp2Hit = true
  }

  // 4. Trailing stop update + check (on remaining after TP1)
  if (pos.tp1Hit && pos.remainingSizePct > 0) {
    const atrMultiplier = ATR_TRAIL_MULTIPLIER[pos.interval] ?? 2.0
    pos.trailingState = this.updateTrailing(pos, candle, atrMultiplier)
    if (pos.trailingState.active && isTrailingStopHit(pos.side, candle.c, pos.trailingState)) {
      this.closeRemaining(pos, pos.trailingState.currentStopPrice, barIndex, candle.t, 'trail_stop')
    }
  }
}
```

**New private methods:**

```typescript
private executePartialClose(
  pos: OpenPosition,
  level: 'tp1' | 'tp2' | 'trail',
  price: number,
  closePct: number,      // fraction of ORIGINAL position
  barIndex: number,
  time: number,
): void {
  const slippage = price * this.slippagePct
  const fillPrice = pos.side === 'long' ? price - slippage : price + slippage
  
  const partialSizeUsd = pos.sizeUsd * closePct
  const priceChange = pos.side === 'long'
    ? fillPrice - pos.entryPrice
    : pos.entryPrice - fillPrice
  const rawPnl = (priceChange / pos.entryPrice) * partialSizeUsd
  const commission = partialSizeUsd * this.commissionPct
  const pnl = rawPnl - commission
  
  this.equity += pnl
  pos.remainingSizePct -= closePct
  
  pos.partialCloses.push({ level, price: fillPrice, closePct, pnl, barIndex, time })
}

private closeRemaining(
  pos: OpenPosition,
  exitPrice: number,
  barIndex: number,
  exitTime: number,
  exitReason: BacktestTrade['exitReason'],
): void {
  // Close whatever fraction remains
  if (pos.remainingSizePct > 0) {
    this.executePartialClose(pos, 'trail', exitPrice, pos.remainingSizePct, barIndex, exitTime)
  }
  
  // Build final trade record with weighted average
  this.recordTrade(pos, barIndex, exitTime, exitReason)
  this.positions.delete(pos.coin)
}

private recordTrade(pos: OpenPosition, barIndex: number, exitTime: number, exitReason: BacktestTrade['exitReason']): void {
  // Compute weighted average exit price
  let totalWeightedPrice = 0
  let totalPct = 0
  for (const pc of pos.partialCloses) {
    totalWeightedPrice += pc.price * pc.closePct
    totalPct += pc.closePct
  }
  const weightedExitPrice = totalPct > 0 ? totalWeightedPrice / totalPct : pos.entryPrice
  const totalPnl = pos.partialCloses.reduce((sum, pc) => sum + pc.pnl, 0)
  const holdingBars = barIndex - pos.entryBarIndex

  this.trades.push({
    coin: pos.coin,
    interval: pos.setup.interval,
    side: pos.side,
    patternType: pos.setup.type,
    confluenceGrade: pos.setup.confluenceGrade ?? null,
    entryPrice: pos.entryPrice,
    exitPrice: weightedExitPrice,
    weightedExitPrice,
    slPrice: pos.slPrice,         // original SL
    tpPrice: pos.tp1Price,        // backward compat: TP1
    tp1Price: pos.tp1Price,
    tp2Price: pos.tp2Price,
    sizeUsd: pos.sizeUsd,
    entryTime: pos.entryTime,
    exitTime,
    holdingBars,
    pnl: totalPnl,
    pnlPct: pos.sizeUsd > 0 ? totalPnl / pos.sizeUsd : 0,
    exitReason,
    partialCloses: pos.partialCloses,
  })
}

private updateTrailing(pos: OpenPosition, candle: Candle, atrMultiplier: number): TrailingStopState {
  // ATR-based trailing: trail distance = ATR * multiplier
  // We need candle data to compute ATR — but simulator doesn't have candle history.
  // DESIGN DECISION: Pass ATR value at entry time OR compute per-bar.
  // Simpler: use a percentage-based trail derived from ATR at entry.
  // Better: engine.ts passes candle arrays. See Step 4.
  // For now, use percentage-based from existing computeTrailingStop.
  
  const trailConfig: TrailingStopConfig = {
    activationPct: 0,  // already activated (TP1 was hit)
    trailPct: atrMultiplier * 0.01,  // approximate: 1.5-2.5% trail
  }
  return computeTrailingStop(pos.side, pos.entryPrice, candle.c, pos.trailingState, trailConfig)
}
```

**Critical trailing refinement** — The `updateTrailing` needs actual ATR values, not approximations. Two approaches:

- **Approach A (simpler)**: At `tryFill` time, compute ATR from the candle array (engine has it) and store `atrAtEntry` on OpenPosition. Use `atrAtEntry * multiplier / entryPrice` as `trailPct`. This is fixed for the trade's lifetime — acceptable for backtesting.
- **Approach B (accurate)**: Engine passes candle array reference on each `checkBar` call so simulator can compute ATR per bar. Requires changing `checkBar` signature.

**Recommend Approach A** for v1: store `atrAtEntry` on the position. Keeps the simulator signature unchanged.

This means `tryFill` needs to accept an ATR value. Modify signature:
```typescript
tryFill(setup: ActiveSetup, barIndex: number, atrValue?: number): boolean
```

Store on position:
```typescript
atrAtEntry: number  // ATR(14) at entry time
```

Then `updateTrailing` uses:
```typescript
const trailDistance = pos.atrAtEntry * atrMultiplier
const trailPct = trailDistance / pos.entryPrice
```

---

## Step 4: Engine changes to pass ATR to simulator

### File: `src/backtest/engine.ts`

Minimal change: compute ATR at fill time and pass to `tryFill`.

In the `onSetup` callback:
```typescript
const onSetup = (setup: ActiveSetup) => {
  // Compute ATR for trailing stop calculation
  const key = `${setup.coin}:${setup.interval}`
  const candleArr = candles.get(key)
  let atrVal = 0
  if (candleArr && candleArr.length > 14) {
    atrVal = atr(candleArr, Math.min(currentBarIndex, candleArr.length - 1), 14)
  }
  simulator.tryFill(setup, currentBarIndex, isNaN(atrVal) ? 0 : atrVal)
}
```

New import: `import { atr } from '../indicators/core.js'`

Note: `currentBarIndex` is the replay event index, not the candle array index. We need the candle array index. The replay events are interleaved across coins/TFs, so `currentBarIndex` does not correspond to the candle array index for a specific coin:TF pair.

**Fix**: Track per-key candle indices. Add a `Map<string, number>` that increments each time a candle for that key is replayed:

```typescript
const candleIndices = new Map<string, number>()

// In replay loop:
const key = `${event.coin}:${event.interval}`
const ci = (candleIndices.get(key) ?? -1) + 1
candleIndices.set(key, ci)
```

Then in `onSetup`:
```typescript
const key = `${setup.coin}:${setup.interval}`
const candleArr = candles.get(key)
const ci = candleIndices.get(key) ?? 0
let atrVal = 0
if (candleArr && ci >= 14) {
  atrVal = atr(candleArr, ci, 14)
}
```

---

## Step 5: Update Signal and ActiveSetup types

### File: `src/types.ts`

Add to `Signal` interface:
```typescript
tp1Price?: number   // structure-based TP1 (zone target)
tp2Price?: number   // swing-based TP2 (pivot target)
```

`ActiveSetup extends Signal` — fields flow through automatically. No changes needed to ActiveSetup.

---

## Step 6: Update metrics.ts for new trade fields

### File: `src/backtest/metrics.ts`

The `computeMetrics` function aggregates over `BacktestTrade[]`. The key metric that changes:

- `avgRR` computation currently uses `(exitPrice - entryPrice) / (entryPrice - slPrice)`. With weighted exit price, this still works — just uses `weightedExitPrice` instead.
- Add new metrics (optional, for diagnostics):
  - `tp1HitRate`: fraction of trades where TP1 was reached
  - `tp2HitRate`: fraction of trades where TP2 was reached
  - `avgPartialsPerTrade`: average number of partial closes

These are additive — add to `BacktestMetrics` interface and compute them.

---

## Step 7: Update report.ts for new output

### File: `src/backtest/report.ts`

Add columns for TP1/TP2 hit rates and partial close statistics to the console output. Minor formatting change.

---

## Implementation Sequence

| Step | Files Modified | Dependencies | Effort |
|------|---------------|-------------|--------|
| 1 | `types.ts`, `backtest/types.ts`, `config.ts` | None | Small |
| 2 | `scanner/layers/trigger.ts` | Step 1 (types + config) | Medium |
| 3 | `backtest/simulator.ts` | Step 1 (types), imports from `agent/exits.ts` | Large — core work |
| 4 | `backtest/engine.ts` | Step 3 (simulator signature change) | Small |
| 5 | `backtest/metrics.ts`, `backtest/types.ts` | Step 3 (new trade fields) | Small |
| 6 | `backtest/report.ts` | Step 5 (new metrics) | Small |

**Total estimated: ~400-500 lines changed/added across 7 files.**

---

## Test Strategy

### Unit Tests

1. **`trigger.test.ts`** — Test `computeStructureTargets`:
   - Long with supply zone above entry → TP1 = zone bottom
   - Long with no supply zone → fallback 2R
   - TP1 too close (< 1.5R) → fallback
   - Short with demand zone below → TP1 = zone top
   - TP2 from swing pivot beyond TP1
   - TP2 fallback when no qualifying pivot

2. **`simulator.test.ts`** — Test multi-level exit:
   - Trade hits TP1 only, then SL at breakeven → 40% profit, 60% breakeven
   - Trade hits TP1 + TP2, then trailing → full profit across 3 levels
   - Trade hits SL before TP1 → full loss (same as current behavior)
   - Trade hits TP1, trailing activates, trailing stop hit → 40% + 30% trail profit
   - Partial close PnL arithmetic: weighted exit price matches manual calc
   - SL moves to breakeven after TP1 → verify `currentSlPrice == entryPrice`
   - Remaining size tracking: 1.0 → 0.6 → 0.3 → 0.0
   - End-of-data with partial position → closes remainder at market

3. **`exits.test.ts`** — Existing tests should still pass (no changes to exits.ts functions).

### Integration Test

4. **Run full backtest on the same dataset** that produced 5/5 SL hits:
   - Verify at least some trades now hit TP1 (structure targets closer than 2R)
   - Verify partial close records appear in trades
   - Verify equity curve improves
   - Verify `trail_stop` exit reason appears

### Regression

5. **Walk-forward re-run**: After changes, re-run the 6-month WFA to compare OOS metrics.
   - Current: $42.57/trade, 4.26% return
   - Target: higher expectancy due to more TP1 hits and trailing capture of extended moves

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Structure TP too aggressive (too close) | MIN_TP1_RR = 1.5 floor. Falls back to 2R if zone too near. |
| Trailing too tight on volatile TFs | Per-TF ATR multiplier (1.5x/2.0x/2.5x). ATR naturally adapts. |
| Partial close complicates metrics | Single BacktestTrade with weighted avg. Metrics code sees one trade. |
| Backward compatibility | `tpPrice` still set to TP1. `tp1Price`/`tp2Price` are optional on Signal. Old consumers unaffected. |
| ATR stale at entry | Acceptable for backtest v1. Live agent already updates trailing per tick via `position-monitor.ts`. |

---

## Files NOT Changed

- `agent/exits.ts` — reuse `computeTrailingStop`, `isTrailingStopHit`, `TrailingStopState` as-is
- `scanner/pipeline.ts` — no changes needed; setup emission unchanged
- `scanner/layers/zones.ts` — unchanged; trigger.ts calls `compileKeyZones` directly
- `indicators/structure.ts`, `indicators/smc.ts`, `indicators/core.ts` — pure utilities, unchanged
