# Minh (明) — Market Memory Spec

> Archive draft note (2026-04-15): this is a forward-looking design spec only. `src/strategy/shared/market-memory.ts` does not exist on the current branch, and the live runtime does not depend on this design yet.

Design spec for a deterministic market-state representation layer that compresses raw candles into reusable structured context.

This document turns the "candles -> pages -> books -> library" idea into repo-native architecture.

Important: this is **not** Sprint 6/7 advisor memory. That system stores and retrieves human-facing memories for the LLM advisor. Market Memory is a **pure-computation runtime layer** used by the scanner and strategies on every closed bar.

---

## 1. Problem Statement

Today Minh can already detect:

- regime
- Wyckoff phase and event
- structure breaks
- zones
- VSA context
- HTF alignment

But each strategy still reassembles the market story locally from low-level pieces. That creates three problems:

1. **Repeated local reasoning**
   - Each strategy has to infer "what story is price telling?" from candles, breaks, zones, and regime again.

2. **Weak cross-timeframe narrative**
   - `StrategyContext` currently carries only `htfCandles` and `htfInterval`.
   - This is useful, but too low-level for a strategy that wants a macro answer like "is this breakout acceptance or a trap inside HTF distribution?"

3. **No shared market memory abstraction**
   - The repo has indicators and signals, but not a reusable representation of "current chapter", "who is in control", "is the move exhausted", or "is this lower-TF move aligned with the higher-TF book?"

The result is a pipeline that sees well, but still remembers the market mostly as raw price arrays.

---

## 2. Design Goal

Add a new bounded, deterministic layer called `Market Memory`.

Conceptually:

```text
Candle[] -> MarketEvent[] -> MarketChapter[] -> TimeframeBook -> MarketMemoryGraph -> StrategyContext
```

Where:

- `MarketEvent` = an important thing that just happened
- `MarketChapter` = a bounded slice of recent market behavior
- `TimeframeBook` = the current story of one timeframe
- `MarketMemoryGraph` = structured relationships between the current timeframe book and its HTF book

This gives strategies a reusable answer to:

- who is in control?
- is the current move continuation, accumulation, distribution, exhaustion, or trap?
- is the LTF setup confirmed or contradicted by the HTF book?
- should this setup get a small confidence bonus, a penalty, or a hard block?

---

## 3. Non-Goals

This spec explicitly does **not** do the following:

- no LLM
- no text generation in runtime
- no database storage
- no persistent graph database
- no replaying every candle as prose
- no replacement of the existing indicator layer
- no I/O outside current feed/orchestrator boundaries

The "wiki" metaphor is conceptual only. In code, Market Memory stays fully structured and typed.

---

## 4. Core Invariants

The layer must preserve these repo constraints:

1. **Pure computation only**
   - All Market Memory builders live in strategy/indicator shared pure code.
   - No network, DB, file writes, timers, or hidden state.

2. **Closed-candle only**
   - Build from the same `idx = candles.length - 2` closed-bar gate used by `orchestrator.ts`.

3. **Bounded memory**
   - Never keep unbounded event/chapter history.
   - Use only recent landmarks and a fixed max number of chapters.

4. **Deterministic**
   - Same candle input -> same book/graph output.

5. **Soft-first rollout**
   - Phase 1 only informs confidence/gating.
   - It must not replace existing bias/invalidation logic on day one.

---

## 5. Placement In This Repo

### New files

```text
src/strategy/shared/market-memory.ts
src/strategy/shared/market-memory.test.ts
```

### Existing files to extend later during implementation

```text
src/types.ts
src/config.ts
src/strategy/shared/indicator-cache.ts
src/strategy/orchestrator.ts
src/strategy/strategies/smc-sd/index.ts
```

### Why `strategy/shared/` and not `indicators/`

Market Memory is not a primitive indicator like ATR or RSI. It is a higher-order composition layer built from:

- regime
- Wyckoff
- structure breaks
- zones
- VSA
- HTF context

That makes `src/strategy/shared/market-memory.ts` the best fit:

- still pure
- close to strategy orchestration
- not mixed into primitive indicator modules

---

## 6. Terminology

To avoid ambiguous naming, code should use these exact terms:

| Concept | Code Term | Meaning |
|---|---|---|
| Important market action | `MarketEvent` | Structure break, sweep, trap, zone reaction, etc. |
| Recent market slice | `MarketChapter` | A bounded chapter between major landmarks |
| One timeframe story | `TimeframeBook` | Current market thesis for a TF |
| Cross-timeframe relation set | `MarketMemoryGraph` | Typed edges between books/events |

Do **not** use `wiki`, `llmWiki`, `storyText`, or other prose-oriented names in runtime types.

---

## 7. Data Model

These types should be added to `src/types.ts`.

```ts
export type MarketEventKind =
  | 'regime-transition'
  | 'structure-break'
  | 'liquidity-sweep'
  | 'zone-reaction'
  | 'zone-failure'
  | 'fvg-created'
  | 'fvg-filled'
  | 'breaker-reaction'
  | 'wyckoff-event'
  | 'volume-anomaly'
  | 'volatility-expansion'
  | 'volatility-compression'

export type MarketEventDirection = 'bullish' | 'bearish' | 'neutral'

export type MarketControl = 'buyers' | 'sellers' | 'balanced' | 'contested'

export type MarketNarrative =
  | 'trend-continuation'
  | 'trend-exhaustion'
  | 'accumulation'
  | 'distribution'
  | 'range-auction'
  | 'breakout-acceptance'
  | 'breakout-failure'
  | 'liquidity-trap'
  | 'reversal-attempt'

export interface MarketEvent {
  kind: MarketEventKind
  direction: MarketEventDirection
  index: number
  price: number
  strength: number        // 0-1
  source: string          // 'wyckoff', 'smc', 'vsa', 'derived'
  tags: string[]          // e.g. ['spring', 'discount', 'high-volume']
}

export interface MarketChapter {
  startIdx: number
  endIdx: number
  narrative: MarketNarrative
  control: MarketControl
  direction: 'long' | 'short' | 'neutral'
  continuationScore: number  // 0-1
  exhaustionScore: number    // 0-1
  trapRisk: number           // 0-1
  eventIds: number[]         // indexes into TimeframeBook.activeEvents
}

export interface TimeframeBook {
  interval: CandleInterval
  asOfIdx: number
  asOfTs: number
  regime: MarketRegime
  control: MarketControl
  dominantNarrative: MarketNarrative
  thesisSide: 'long' | 'short' | 'neutral'
  thesisConfidence: number   // 0-1
  continuationScore: number  // 0-1
  exhaustionScore: number    // 0-1
  trapRisk: number           // 0-1
  volatilityState: 'compression' | 'normal' | 'expansion'
  liquidityState: 'below-resting' | 'above-resting' | 'two-sided' | 'none'
  invalidationLevel: number | null
  activeEvents: MarketEvent[]
  chapters: MarketChapter[]
  tags: string[]             // compact structured summary, not prose
}

export type MarketMemoryEdgeType =
  | 'confirms'
  | 'contradicts'
  | 'leads-to'
  | 'traps'
  | 'targets'

export interface MarketMemoryEdge {
  from: 'ltf-book' | 'htf-book' | `event:${number}`
  to: 'ltf-book' | 'htf-book' | `event:${number}`
  type: MarketMemoryEdgeType
  strength: number           // 0-1
}

export interface MarketMemoryGraph {
  thesisAlignment: 'aligned' | 'counter' | 'neutral'
  contradictionScore: number // 0-1
  confirmationScore: number  // 0-1
  edges: MarketMemoryEdge[]
}
```

### `StrategyContext` extension

Extend the existing interface in `src/types.ts`:

```ts
export interface StrategyContext {
  htfCandles?: Candle[]
  htfInterval?: CandleInterval
  book?: TimeframeBook
  htfBook?: TimeframeBook
  marketGraph?: MarketMemoryGraph
}
```

This keeps backward compatibility:

- existing strategies can ignore the new fields
- `smc-sd` can adopt them incrementally

---

## 8. Builder API

`src/strategy/shared/market-memory.ts` should expose exactly these pure functions:

```ts
export interface MarketMemoryInputs {
  coin: string
  interval: CandleInterval
  candles: Candle[]
  idx: number
  atr14: number
  adx14: number
  volumeRatio20: number
  regime: MarketRegime
  wyckoff: WyckoffResult
  breaks: StructureBreak[]
  pivots: PivotPoint[]
  demandZones: KeyZone[]
  supplyZones: KeyZone[]
  vsaSignals: VSASignal[]
  breakerBlocks: BreakerBlock[]
  inversionFVGs: InversionFVG[]
}

export function buildMarketEvents(inputs: MarketMemoryInputs): MarketEvent[]
export function buildMarketChapters(inputs: MarketMemoryInputs, events: MarketEvent[]): MarketChapter[]
export function buildTimeframeBook(inputs: MarketMemoryInputs): TimeframeBook | null
export function buildMarketMemoryGraph(book: TimeframeBook, htfBook?: TimeframeBook): MarketMemoryGraph
```

### Why this API shape

The builder accepts precomputed inputs instead of reaching back into caches repeatedly.

That matters because current `indicator-cache.ts` caches only one bar state per `coin|interval`. A book builder that rescans many historical `idx` values through that cache would create churn and hidden recomputation. The builder should therefore:

- consume the current bar's cached outputs once
- derive the book from recent landmark arrays already available at `idx`
- avoid per-bar historical cache walking in V1

---

## 9. Event Extraction Rules

`buildMarketEvents()` should be conservative: only capture high-signal events that are useful for strategy context.

### Event sources from current repo

| Event kind | Source in repo | Bull/Bear direction rule |
|---|---|---|
| `structure-break` | `getCachedStructureBreaks()` | break direction |
| `wyckoff-event` | `getCachedWyckoff()` | `spring` bullish, `utad` bearish |
| `zone-reaction` | current candle vs demand/supply zones | rejection direction |
| `zone-failure` | close through active zone | failure direction |
| `breaker-reaction` | breaker block touch + reject | reaction direction |
| `liquidity-sweep` | most recent sweep-like break + reclaim | sweep direction |
| `volume-anomaly` | `getCachedVsa()` and volume ratio | signal direction |
| `volatility-expansion` | ATR/range expansion | direction = candle direction |
| `volatility-compression` | ATR/range compression | neutral |

### Concrete V1 rules

1. Keep at most the last `MARKET_MEMORY_MAX_EVENTS` events.
2. Prefer landmark events over repetitive ones.
3. Deduplicate by `(kind, direction, near same index)`.
4. Strength is normalized to `0-1`.

### Suggested strength rules

| Event | Strength rule |
|---|---|
| CHoCH | `0.85` |
| BOS | `0.70` |
| Spring / UTAD | `0.85` |
| Strong zone rejection | `0.60 + zone.strength * 0.3` |
| Zone failure | `0.75` |
| VSA alignment | `0.55` |
| High-volume expansion | `0.50` |

---

## 10. Chapter Builder Rules

`buildMarketChapters()` should summarize the recent market into bounded chapters without storing unbounded history.

### Chapter boundaries

V1 boundaries are created from:

- recent opposing `structure-break` events
- the latest same-side follow-through break
- a major `wyckoff-event`
- max chapter age in bars

Suggested defaults:

- chapter lookback: last `120` bars
- max chapters kept: `6`
- max chapter width: `40` bars

### Chapter classification

Each chapter gets:

- `control`
- `direction`
- `continuationScore`
- `exhaustionScore`
- `trapRisk`
- `narrative`

### Control score

Use an evidence-point model:

| Evidence | Buyers | Sellers |
|---|---:|---:|
| bullish CHoCH in chapter | +3 | 0 |
| bullish BOS in chapter | +2 | 0 |
| spring / bullish sweep reclaim | +3 | 0 |
| bullish zone rejection | +2 | 0 |
| bullish VSA alignment | +1 | 0 |
| BULL regime | +1 | 0 |
| bearish equivalents | 0 | mirrored |

Map total points:

- diff `>= 3` -> `buyers`
- diff `<= -3` -> `sellers`
- diff `0` -> `balanced`
- otherwise -> `contested`

### Narrative assignment

Use this priority order:

1. `liquidity-trap`
   - sweep or break beyond a recent level
   - close back inside or immediate rejection
   - `trapRisk >= 0.70`

2. `breakout-failure`
   - recent break exists
   - follow-through is weak
   - opposing rejection/failure event appears in same chapter

3. `breakout-acceptance`
   - recent break exists
   - chapter control agrees with break direction
   - `continuationScore >= 0.65`
   - `trapRisk <= 0.35`

4. `accumulation` / `distribution`
   - balanced or contested control
   - Wyckoff phase matches

5. `trend-exhaustion`
   - same-side continuation exists
   - `exhaustionScore >= 0.65`
   - opposing anomaly exists

6. `trend-continuation`
   - directional control
   - `continuationScore >= 0.60`

7. `range-auction`
   - none of the above and control not directional

8. `reversal-attempt`
   - chapter is early counter-control without enough continuation evidence yet

---

## 11. Book Synthesis Rules

`buildTimeframeBook()` combines active events and chapters into a one-timeframe thesis.

### Thesis fields

#### `thesisSide`

Rules:

- `long` when dominant chapter control is `buyers` and dominant narrative is one of:
  - `trend-continuation`
  - `breakout-acceptance`
  - `accumulation`
  - `reversal-attempt` with bullish control

- `short` with mirrored bearish conditions

- `neutral` otherwise

#### `thesisConfidence`

Suggested formula:

```text
base = dominant chapter continuationScore
bonus = +0.10 if control is directional
bonus = +0.10 if Wyckoff phase agrees
penalty = trapRisk * 0.20
penalty = exhaustionScore * 0.15
thesisConfidence = clamp01(base + bonus - penalty)
```

#### `invalidationLevel`

Rules:

- for `long`: nearest meaningful low / demand floor / spring low
- for `short`: nearest meaningful high / supply ceiling / UTAD high
- `null` when no defensible invalidation exists

#### `liquidityState`

Rules:

- `below-resting` when recent lows are primary liquidity target above confidence threshold
- `above-resting` for mirrored case
- `two-sided` when both sides remain unresolved in a range
- `none` when no strong nearby target

### Book tags

`tags` must stay structured and compact, for example:

```ts
['wyckoff:accumulation', 'control:buyers', 'narrative:trend-continuation', 'risk:low-trap']
```

No runtime free-form paragraphs.

---

## 12. Graph Rules

`buildMarketMemoryGraph()` relates the LTF book to the HTF book.

V1 graph is intentionally small. It is **not** a general graph engine.

### Inputs

- `book` = current timeframe book
- `htfBook` = higher timeframe book, when available

### Required outputs

- `thesisAlignment`
- `confirmationScore`
- `contradictionScore`
- typed `edges`

### Edge rules

1. `confirms`
   - if `book.thesisSide === htfBook.thesisSide`
   - strength = min(book confidence, htfBook confidence)

2. `contradicts`
   - if both sides are directional and opposite
   - strength = max(book confidence, htfBook confidence)

3. `traps`
   - if LTF narrative is `liquidity-trap` or `breakout-failure`
   - and current setup direction would follow the failed move

4. `leads-to`
   - optional V1 edge for event chains like:
     - sweep -> CHoCH
     - zone reaction -> displacement
     - compression -> expansion

5. `targets`
   - reserved for later use when TP logic wants graph-derived liquidity targets

### Alignment scoring

Suggested rules:

- `aligned` when same directional side and `contradictionScore < 0.35`
- `counter` when opposite directional side or trap edge is strong
- `neutral` otherwise

---

## 13. Config Additions

All thresholds belong in `src/config.ts`.

Suggested initial constants:

```ts
export const MARKET_MEMORY_ENABLED = false
export const MARKET_MEMORY_EVENT_LOOKBACK = 24
export const MARKET_MEMORY_CHAPTER_LOOKBACK = 120
export const MARKET_MEMORY_MAX_CHAPTERS = 6
export const MARKET_MEMORY_MAX_CHAPTER_BARS = 40
export const MARKET_MEMORY_MAX_EVENTS = 10

export const MARKET_MEMORY_ALIGNMENT_BONUS = 0.04
export const MARKET_MEMORY_COUNTER_PENALTY = 0.06
export const MARKET_MEMORY_TRAP_BLOCK_THRESHOLD = 0.80
export const MARKET_MEMORY_CONTRADICTION_BLOCK_THRESHOLD = 0.85

export const MARKET_MEMORY_CONTINUATION_MIN = 0.60
export const MARKET_MEMORY_EXHAUSTION_HIGH = 0.65
export const MARKET_MEMORY_TRAP_HIGH = 0.70
```

### Rollout note

Start with `MARKET_MEMORY_ENABLED = false`.

This allows:

- shipping types and builders first
- benchmarking overhead
- soft-enabling only inside one strategy path later

---

## 14. Cache Integration

`src/strategy/shared/indicator-cache.ts` should be extended with cached book accessors.

Suggested additions:

```ts
  timeframeBook?: TimeframeBook
  marketGraphByHtfTs?: Map<number, MarketMemoryGraph>
```

And new getters:

```ts
export function getCachedTimeframeBook(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): TimeframeBook | null

export function getCachedMarketMemoryGraph(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  htfBook?: TimeframeBook,
): MarketMemoryGraph
```

### Important constraint

Do not create a second parallel cache file in V1 unless `indicator-cache.ts` becomes unreadable. Keeping book/graph caching in the existing shared cache reduces coordination overhead and matches the current architecture.

---

## 15. Orchestrator Integration

`src/strategy/orchestrator.ts` already builds HTF context. The Market Memory integration should happen in the same place.

### Current flow

```text
candles -> htfCandles -> context(htfCandles, htfInterval) -> registry.runAll()
```

### New flow

```text
candles
  -> htfCandles
  -> book = getCachedTimeframeBook(...)
  -> htfBook = getCachedTimeframeBook(...) on HTF
  -> marketGraph = getCachedMarketMemoryGraph(..., htfBook)
  -> context = { htfCandles, htfInterval, book, htfBook, marketGraph }
  -> registry.runAll()
```

### Status snapshot integration

Do not block the first rollout on `StatusSnapshot` changes.

Optional later additions to `StatusSnapshot`:

- `narrative`
- `control`
- `trapRisk`

This is useful for TUI/dashboard, but not required for core adoption.

---

## 16. Strategy Integration

### Adoption target: `smc-sd` first

`src/strategy/strategies/smc-sd/index.ts` is the correct first consumer because it already reasons across:

- HTF structure
- drill-down context
- zone confirmation
- regime confidence

### V1 usage rules

Market Memory should affect `smc-sd` in three ways only:

1. **alignment bonus**
   - if setup side matches `context.book?.thesisSide`
   - and `context.marketGraph?.thesisAlignment === 'aligned'`

2. **counter penalty**
   - if setup side conflicts with book or HTF book

3. **trap block**
   - if `context.book?.trapRisk >= MARKET_MEMORY_TRAP_BLOCK_THRESHOLD`
   - and the setup follows the trapped direction

### Concrete confidence rules

Suggested logic:

```ts
if (context?.book?.thesisSide === side) confidence += MARKET_MEMORY_ALIGNMENT_BONUS
if (context?.marketGraph?.thesisAlignment === 'counter') confidence -= MARKET_MEMORY_COUNTER_PENALTY
if ((context?.book?.trapRisk ?? 0) >= MARKET_MEMORY_TRAP_BLOCK_THRESHOLD) return null
```

### Pattern data enrichment

When a signal is emitted, add these fields to `patternData`:

```ts
bookNarrative: context?.book?.dominantNarrative
bookControl: context?.book?.control
bookTrapRisk: context?.book?.trapRisk
graphAlignment: context?.marketGraph?.thesisAlignment
graphConfirmation: context?.marketGraph?.confirmationScore
```

This makes later analytics/backtests able to answer:

- "Do continuation trades perform better when book narrative is breakout-acceptance?"
- "How many losses came from taking setups inside a high trap-risk chapter?"

---

## 17. Rollout Plan

The feature should be implemented in these sessions, not as one large merge.

### Session 1: Types + config + pure builder

Files:

- `src/types.ts`
- `src/config.ts`
- `src/strategy/shared/market-memory.ts`
- `src/strategy/shared/market-memory.test.ts`

Deliverables:

- new types
- builder skeleton
- hand-crafted book tests

### Session 2: Cache wiring

Files:

- `src/strategy/shared/indicator-cache.ts`
- tests

Deliverables:

- cached book getter
- cached graph getter
- no strategy behavior change yet

### Session 3: Orchestrator context

Files:

- `src/strategy/orchestrator.ts`
- tests

Deliverables:

- `StrategyContext` now carries `book`, `htfBook`, `marketGraph`
- disabled flag preserves old behavior

### Session 4: `smc-sd` soft adoption

Files:

- `src/strategy/strategies/smc-sd/index.ts`
- tests

Deliverables:

- alignment bonus
- counter penalty
- trap block
- `patternData` enrichment

### Session 5: Bench + operator surfaces

Files:

- pipeline benchmark
- optional status snapshot/TUI

Deliverables:

- overhead measured
- optional watchlist narrative visibility

---

## 18. Test Plan

This feature needs both correctness tests and budget tests.

### Unit tests

`src/strategy/shared/market-memory.test.ts`

Minimum fixture scenarios:

1. bullish continuation after spring
2. bearish distribution with UTAD and failed breakout
3. sideways range auction with two-sided liquidity
4. false breakout -> liquidity trap
5. exhaustion after extended bullish BOS sequence
6. empty / insufficient candles -> `null`

### Integration tests

Add or extend tests around:

- `orchestrator.ts` context building
- `smc-sd` confidence behavior when Market Memory is enabled
- no regression when Market Memory is disabled

### Quality-gate specific checks

- no `any`
- no I/O
- bounded arrays
- no hidden mutable state outside existing cache
- `bun test --run` must pass

### Performance verification

Run the existing pipeline benchmark and compare:

- baseline without Market Memory
- Market Memory enabled with context only
- Market Memory enabled with `smc-sd` consumption

Target:

- no meaningful regression in hot scan path
- if overhead is material, reduce event count/chapter depth before merging

---

## 19. Failure Modes To Guard Against

1. **Narrative overfitting**
   - The builder sees patterns everywhere and becomes a fancy wrapper around noise.
   - Mitigation: keep event vocabulary small and strength-gated.

2. **Cache churn**
   - Recomputing deep history through the single-entry cache ruins latency.
   - Mitigation: builder consumes current cached arrays once.

3. **Strategy lock-in**
   - If Market Memory becomes mandatory everywhere too early, debugging gets harder.
   - Mitigation: soft-first adoption, feature flag, one strategy first.

4. **Duplication with bias**
   - Book thesis and `determineBias()` drift apart.
   - Mitigation: Phase 1 bias remains authoritative; Market Memory is advisory context.

5. **Semantic confusion with Sprint 6/7**
   - Operator confuses advisor memory with runtime market memory.
   - Mitigation: always document them as separate systems.

---

## 20. Final Decision

Implement Market Memory as a **bounded, deterministic, strategy-context layer**.

It should:

- sit above indicators and below strategies
- summarize candles into events, chapters, and books
- create a small cross-timeframe graph for confirmation/contradiction
- stay pure and cheap enough for the live scan path
- start as soft context, not a hard replacement for the current bias engine

This is the cleanest way to give Minh a "super memory" of market structure without violating the repo's core identity:

- no LLM in execution
- no hidden I/O
- no unbounded state
- no loss of determinism
