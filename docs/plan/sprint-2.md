# Minh (明) — Sprint 2: Algorithmic Agent Trading

## Goal

Transform the Sprint 1 analysis engine into an **autonomous trading agent** — self-deciding, self-executing, self-adapting. No human in the loop for trade execution.

**Sprint 2 = Agent Core + Execution + Infrastructure. Analysis engine (Sprint 1) is foundation.**

Key distinction: **Agent ≠ Tool.** Tool needs human approval. Agent autonomously decides, executes, monitors, and adapts.

---

## Architecture Overview

```
Sprint 1 (Analysis):
  Market Data → Pipeline (5 layers) → Signal + Confluence Grade

Sprint 2 (Agent):
  Signal → Agent State Machine → Risk Gate → Execute → Monitor → Adapt
              ↕                      ↕          ↕         ↕
           PostgreSQL            Circuit      Elysia    Trade
           + TimescaleDB         Breakers     HTTP API   Journal
```

### Full System Architecture (Sprint 2)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Minh (明) Sprint 2                               │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Sprint 1 (unchanged)                                            │   │
│  │  Feed (REST+WS) → Store → Pipeline (5 layers) → Signal+Grade    │   │
│  │  Pipeline emits 'setup' events via EventEmitter                  │   │
│  └──────────────────────────────┬───────────────────────────────────┘   │
│                                 │ EventEmitter 'setup'                  │
│                                 ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  AGENT STATE MACHINE (src/agent/trading-agent.ts)                │   │
│  │  State-handler pattern: handleIdle, handleWatching, etc.         │   │
│  │                                                                  │   │
│  │  IDLE ──► WATCHING ──► ENTERING ──► IN_POSITION ──► EXITING     │   │
│  │   ▲          │            │              │              │        │   │
│  │   │          ▼            ▼              ▼              ▼        │   │
│  │   └── invalidate    reject/timeout   trail/TP/SL    close done  │   │
│  │   ▲                                                     │        │   │
│  │   └─────────────────────────────────────────────────────┘        │   │
│  │                     ANY ──► PAUSED (circuit breaker / override)  │   │
│  │  CB pauses NEW entries only. IN_POSITION keeps SL/TP on exchange │   │
│  └─────┬──────────┬──────────┬──────────┬──────────┬───────────────┘   │
│        │          │          │          │          │                     │
│  ┌─────▼────┐ ┌──▼───┐ ┌───▼────┐ ┌──▼─────┐ ┌─▼──────────┐         │
│  │ Order    │ │ Pos  │ │ Risk   │ │Circuit │ │ Invalidation│         │
│  │ Manager  │ │ Mon  │ │ Mgmt   │ │Breakers│ │ Bridge      │         │
│  │ +SL/TP   │ │ +sync│ │ real $ │ │        │ │             │         │
│  │ trigger  │ │ hbeat│ │        │ │        │ │             │         │
│  └─────┬────┘ └──────┘ └───┬────┘ └────────┘ └─────────────┘         │
│        │                    │                                           │
│  ┌─────▼────────────────────▼──────────────────────────────────────┐   │
│  │  EXECUTION LAYER                                                 │   │
│  │  viem wallet → HL ExchangeClient → sign (EIP-712) → submit     │   │
│  │  Single ExchangeClient instance, shared by OrderManager + sync  │   │
│  └─────────────────────────┬───────────────────────────────────────┘   │
│                            │                                            │
│  ┌─────────────────────────▼───────────────────────────────────────┐   │
│  │  PERSISTENCE + API                                               │   │
│  │  PostgreSQL+TimescaleDB ◄──► Elysia HTTP (localhost:3000 only)  │   │
│  │  candles, orders, positions, trade_journal                       │   │
│  │  Numbered SQL migrations (src/db/migrations/001_*.sql)           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐                                    │
│  │ Telegram Bot │  │ Terminal UI  │  Notifications                     │
│  └──────────────┘  └──────────────┘                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tech Stack Decisions

| Component | Choice | Rationale (see decisions.md S1-S7) |
|---|---|---|
| Runtime | Bun/TypeScript | Rule-based agent, type safety, 2-5ms/tick |
| Database | PostgreSQL 18 + TimescaleDB | ACID for orders/positions, hypertables for candles, materialized views for analytics |
| DB deploy | Docker Compose | `docker-compose.yml` with `timescale/timescaledb:latest-pg18` image |
| Migrations | Numbered SQL files | `src/db/migrations/001_initial.sql`, simple runner on startup |
| HTTP | Elysia (localhost only) | Execution endpoints need validation, auth; bound to 127.0.0.1 |
| Wallet | viem | EIP-712 signing for Hyperliquid |

### Review Decisions (CEO + Eng)

| # | Decision | Rationale | Session |
|---|---|---|---|
| R1 | Exchange-authoritative crash recovery | On startup: query HL `clearinghouseState` → reconcile with DB → resume correct state | S5 |
| R2 | State-handler pattern | Each state gets own handler (handleIdle, handleWatching, etc.) — testable in isolation | S5 |
| R3 | Exchange-sync heartbeat (~10s) | Poll HL `clearinghouseState` to detect liquidations, external closes, missed fills. Idempotency key on orders | S7 |
| R4 | Localhost-only Elysia binding | Bind to 127.0.0.1. No remote attack surface. Reverse proxy later if needed | S4 |
| R5 | Circuit breaker holds position | CB pauses NEW entries only. Existing positions keep SL/TP on exchange | S11 |
| R6 | Simple log helper | 20-line utility with levels (DEBUG/INFO/WARN/ERROR) + timestamps + component tags. No dependency | S1 |
| R7 | Docker Compose for PostgreSQL | `docker-compose.yml` with `timescale/timescaledb` image in repo | S1 |
| R8 | Skip dead man's switch | HL `scheduleCancel` cancels ALL orders including SL/TP — worse than doing nothing. SL/TP on exchange IS the safety net | — |
| R9 | HL trigger orders for SL/TP | Place SL (trigger-market) + TP (trigger-limit) on HL immediately after fill. Exchange-managed safety | S6 |
| R10 | EventEmitter for pipeline → agent | Pipeline emits 'setup' events, agent subscribes | S5 |
| R11 | `assessRisk()` gets `accountValue` param | Pure function stays pure. Caller passes real balance from HL | S10 |
| R12 | Extract `computePositionSize()` | Shared pure function used by risk-filter + order-manager. DRY | S3 |
| R13 | Numbered SQL migrations | `src/db/migrations/001_*.sql` + simple runner. No ORM | S1 |
| R14 | Sync PG write-through | `await` each candle insert. ~1-5ms latency, guaranteed persistence | S2 |
| R15 | Connection pool max: 5 | Single-process, sequential writes. 5 handles Elysia reads + write-through | S1 |
| R16 | Tests within each session | Each session writes its own tests. No session "done" without passing tests | All |
| R17 | Remove SIMULATED_ACCOUNT | Replace with real balance from HL `clearinghouseState`. Full real-money operation | S10 |

---

## Phase 2A: Infrastructure

### 2A-1. PostgreSQL + TimescaleDB

**Why**: Agent Trading needs ACID transactions (orders, positions), time-series optimization (candles), and audit trail (trade journal).

**Schema**:
```sql
-- Candles: TimescaleDB hypertable
CREATE TABLE candles (
  coin TEXT NOT NULL,
  interval TEXT NOT NULL,
  t TIMESTAMPTZ NOT NULL,
  o DOUBLE PRECISION NOT NULL,
  h DOUBLE PRECISION NOT NULL,
  l DOUBLE PRECISION NOT NULL,
  c DOUBLE PRECISION NOT NULL,
  v DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (coin, interval, t)
);
SELECT create_hypertable('candles', 't');

-- Compression policy (90%+ reduction)
ALTER TABLE candles SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'coin,interval'
);
SELECT add_compression_policy('candles', INTERVAL '7 days');

-- Retention policy
SELECT add_retention_policy('candles', INTERVAL '1 year');

-- Orders: ACID transactional
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  type TEXT NOT NULL CHECK (type IN ('limit', 'market')),
  price DOUBLE PRECISION NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'filled', 'partial', 'cancelled', 'rejected')),
  setup_id TEXT,           -- link to signal that triggered this order
  sl_price DOUBLE PRECISION,
  tp_price DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  filled_at TIMESTAMPTZ,
  fill_price DOUBLE PRECISION,
  exchange_order_id TEXT
);

-- Positions: current state
CREATE TABLE positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price DOUBLE PRECISION NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  sl_price DOUBLE PRECISION,
  tp_price DOUBLE PRECISION,
  unrealized_pnl DOUBLE PRECISION DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closing', 'closed')),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  close_price DOUBLE PRECISION,
  realized_pnl DOUBLE PRECISION
);

-- Trade Journal: audit trail for every agent decision
CREATE TABLE trade_journal (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,    -- 'signal', 'enter', 'exit', 'skip', 'invalidate', 'circuit_break', 'error'
  coin TEXT,
  details JSONB NOT NULL,      -- flexible: signal data, order data, reason, etc.
  agent_state TEXT             -- state at time of event
);
SELECT create_hypertable('trade_journal', 'ts');

-- Continuous aggregate: hourly PnL summary
CREATE MATERIALIZED VIEW pnl_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', closed_at) AS bucket,
  coin,
  COUNT(*) AS trades,
  SUM(realized_pnl) AS total_pnl,
  AVG(realized_pnl) AS avg_pnl
FROM positions
WHERE status = 'closed'
GROUP BY bucket, coin;
```

**Connection**:
```typescript
// src/db/connection.ts
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!, {
  max: 5,                     // connection pool (R15: single-process, sequential)
  idle_timeout: 30,
  connect_timeout: 10,
})
```

**Startup flow change**:
```
Before (Sprint 1): REST backfill ALL 5000 × 18 + Readiness Gate (~9s)
After:
  1. Load candles from PostgreSQL → memory
  2. Gap-fill (lastTimestamp → now) via REST — only missing candles
  3. Readiness Gate + WS subscribe
  Typical: ~1s (if restarted within hours)
```

Save strategy: write-through on each new candle (sync, `await` each insert — R14).

---

### 2A-2. Elysia HTTP Server

**Why**: Programmatic access to agent state + execution control. Validation and auth critical for write endpoints.

```typescript
// src/server/index.ts
import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import { bearer } from '@elysiajs/bearer'

const app = new Elysia()
  .use(cors())
  .use(bearer())
  .onError(({ error, set }) => { /* centralized DB/business error handling */ })

  // Read endpoints (no auth)
  .group('/api', app => app
    .get('/health', () => ({ status, uptime, coins, agentState }))
    .get('/status', () => ({ coins, regimes, bias, confluenceGrades, setupCount }))
    .get('/setups', () => ({ activeSetups }))
    .get('/structure/:coin/:tf', ({ params }) => ({ bias, swings, zones, regime }))
    .get('/candles/:coin/:tf', ({ params, query }) => ({ candles }), {
      query: t.Object({ count: t.Optional(t.Number({ default: 200, maximum: 5000 })) })
    })
  )

  // Agent state endpoints (no auth, read-only)
  .group('/api/agent', app => app
    .get('/state', () => ({ state, positions, dailyPnl, circuitBreakers }))
    .get('/journal', ({ query }) => ({ entries }), {
      query: t.Object({
        limit: t.Optional(t.Number({ default: 50 })),
        type: t.Optional(t.String())
      })
    })
    .get('/positions', () => ({ openPositions, totalExposure }))
  )

  // Execution endpoints (auth required)
  .group('/api/execution', app => app
    .guard({ beforeHandle: ({ bearer }) => { /* verify API token */ }})
    .post('/override/pause', () => { /* pause agent */ })
    .post('/override/resume', () => { /* resume agent */ })
    .post('/override/close-all', () => { /* emergency close all positions */ })
    .delete('/order/:id', ({ params }) => { /* cancel specific order */ }, {
      params: t.Object({ id: t.String() })
    })
  )

  .listen({ port: 3000, hostname: '127.0.0.1' })  // R4: localhost-only
```

---

### 2A-3. Exit Strategies

**Why**: SL/TP computation needed for order execution. Agent must know when to exit.

```
Exit types:
  structure:     SL/TP from nearest zones (already in risk-filter.ts)
  atr:           SL = entry ± ATR×N
  rr-ratio:      TP = entry + (entry - SL) × ratio
  trailing:      activate at +X%, trail at Y%
  partial-close: close 50% at first TP, trail rest
```

Section 12 rules from domain knowledge (structure stop > ATR stop > trailing):
- Stop placement = invalidation level, NOT "comfortable" level
- Position size adjusts to stop distance, never the other way

**R12: Shared position sizing function** (pure, zero I/O):
```typescript
// src/agent/exits.ts (pure functions — exit strategy computations)
// Also exports computePositionSize() used by risk-filter + order-manager

export function computePositionSize(
  accountValue: number,
  riskPercent: number,
  entryPrice: number,
  slPrice: number,
): number {
  const stopDistance = Math.abs(entryPrice - slPrice)
  if (stopDistance === 0) return 0
  const riskAmount = accountValue * riskPercent
  return riskAmount / stopDistance
}
```

---

## Phase 2B: Agent Core

### 2B-1. Agent State Machine

**Why**: The heart of the agent. Without a state machine, execution is a one-shot script, not an agent.

```typescript
// src/agent/trading-agent.ts

type AgentState =
  | 'IDLE'          // no active setups, scanning
  | 'WATCHING'      // setup detected, waiting for confirmation/entry
  | 'ENTERING'      // order placed, awaiting fill
  | 'IN_POSITION'   // position open, monitoring
  | 'EXITING'       // closing position (trailing hit, invalidation, TP)
  | 'PAUSED'        // circuit breaker tripped, manual override, or cooldown

interface AgentContext {
  state: AgentState
  positions: Position[]
  pendingOrders: Order[]
  dailyPnl: number
  consecutiveLosses: number
  lastTradeTime: number
}

class TradingAgent {
  private ctx: AgentContext

  // R2: State-handler pattern — each state has its own handler
  // R10: Pipeline emits 'setup' events, agent subscribes
  async onSignal(signals: ScanResult[]): Promise<void> {
    // Log every decision to trade journal
    const handler = this.handlers[this.ctx.state]
    await handler(signals)
  }

  private handlers = {
    IDLE: (signals) => this.handleIdle(signals),
    WATCHING: (signals) => this.handleWatching(signals),
    ENTERING: (signals) => this.handleEntering(signals),
    IN_POSITION: (signals) => this.handleInPosition(signals),
    EXITING: (signals) => this.handleExiting(signals),
    PAUSED: (signals) => this.handlePaused(signals),
  }

  private async handleIdle(signals): Promise<void> {
    // Evaluate signals → if grade B+ and risk budget OK → transition to WATCHING/ENTERING
  }
  private async handleWatching(signals): Promise<void> {
    // Monitor for entry trigger or invalidation
    // Invalidation → back to IDLE + journal entry
    // Entry trigger → place order → ENTERING
  }
  private async handleEntering(signals): Promise<void> {
    // Check order status: filled → IN_POSITION, rejected → IDLE, timeout → cancel + IDLE
  }
  private async handleInPosition(signals): Promise<void> {
    // Monitor: check SL/TP, trail stop, partial close
    // Pattern invalidation → close position → EXITING
    // TP hit → EXITING
  }
  private async handleExiting(signals): Promise<void> {
    // Confirm position closed → journal PnL → check circuit breakers → IDLE or PAUSED
    // R5: CB pauses NEW entries only, existing positions keep SL/TP on exchange
  }
  private async handlePaused(signals): Promise<void> {
    // Check if cooldown expired or manual resume → IDLE
  }

  // R1: Exchange-authoritative crash recovery
  async recoverFromCrash(): Promise<void> {
    // 1. Query HL clearinghouseState for open positions
    // 2. Reconcile with DB positions table
    // 3. Resume agent in correct state (IDLE or IN_POSITION)
  }
}
```

**State transitions**:
```
IDLE → WATCHING           signal detected, grade B+
WATCHING → ENTERING       entry trigger confirmed
WATCHING → IDLE           signal invalidated
ENTERING → IN_POSITION    order filled
ENTERING → IDLE           order rejected/timeout
IN_POSITION → EXITING     SL/TP/trail/invalidation
EXITING → IDLE            position closed, risk budget OK
EXITING → PAUSED          circuit breaker tripped
PAUSED → IDLE             cooldown expired / manual resume
ANY → PAUSED              emergency override
```

---

### 2B-2. Order Lifecycle Manager

**Why**: Orders have states. Place → fill is not instant. Partials, rejects, timeouts must be handled.

```typescript
// src/agent/order-manager.ts

type OrderStatus = 'pending' | 'submitted' | 'filled' | 'partial' | 'cancelled' | 'rejected'

class OrderManager {
  // Place order with SL/TP
  // R9: After entry fill, place SL (trigger-market) + TP (trigger-limit) on HL
  //     Exchange-managed safety — protected even if agent dies
  async placeOrder(setup: ActiveSetup): Promise<Order>

  // Check order status from exchange
  async syncOrderStatus(orderId: string): Promise<OrderStatus>

  // Cancel unfilled order (idempotency key prevents double-submit — R3)
  async cancelOrder(orderId: string): Promise<void>

  // Modify SL/TP on exchange (trail stop)
  async modifyOrder(orderId: string, updates: Partial<Order>): Promise<void>

  // Handle partial fills
  async onPartialFill(orderId: string, filledSize: number): Promise<void>

  // Timeout: cancel if not filled within N bars
  async checkTimeouts(): Promise<void>
}
```

---

### 2B-3. Position Monitor

**Why**: Once in position, agent must actively manage — trail stop, partial close, exit on invalidation.

```typescript
// src/agent/position-monitor.ts

class PositionMonitor {
  // Called every tick while IN_POSITION
  async monitor(position: Position, currentPrice: number, candles: Candle[]): Promise<MonitorAction>

  // R3: Exchange-sync heartbeat (~10s)
  // Poll HL clearinghouseState → reconcile positions
  // Detects: liquidation, external close, missed fills
  async syncWithExchange(): Promise<void>

  // Actions: 'hold' | 'trail_stop' | 'partial_close' | 'close' | 'alert'
}

// Trail stop logic
// 1. Price moves +X% from entry → activate trailing
// 2. Trail at Y% below highest price since entry
// 3. If price drops to trail level → close

// Partial close logic
// 1. Price hits TP1 (1R) → close 50%
// 2. Move SL to breakeven for remaining 50%
// 3. Trail remaining to TP2 (2R) or trail stop
```

---

### 2B-4. Invalidation → Action Bridge

**Why**: Sprint 1 detects pattern invalidation. Sprint 2 must ACT on it — cancel orders, close positions.

```typescript
// src/agent/invalidation-bridge.ts

// Connect Sprint 1 invalidation engine to Sprint 2 execution
async function onInvalidation(invalidation: InvalidationEvent): Promise<void> {
  // 1. Check if any open order is linked to this pattern
  //    → Cancel order
  // 2. Check if any open position was entered on this pattern
  //    → Close position (market order)
  // 3. Log to trade journal with reason
}
```

---

### 2B-5. Trade Journal

**Why**: Every agent decision must be auditable. Debug, improve, and review.

```typescript
// src/agent/journal.ts

interface JournalEntry {
  ts: Date
  eventType: 'signal' | 'enter' | 'exit' | 'skip' | 'invalidate' | 'circuit_break' | 'error'
  coin: string
  details: {
    reason: string           // why this decision was made
    signalGrade?: string     // confluence grade at time of decision
    agentState: AgentState   // agent state at time of event
    price?: number
    pnl?: number
    riskBudget?: number      // remaining risk budget
    [key: string]: unknown
  }
}

class TradeJournal {
  async log(entry: JournalEntry): Promise<void>        // write to PostgreSQL
  async getEntries(filter: JournalFilter): Promise<JournalEntry[]>
  async dailySummary(date: Date): Promise<DailySummary> // aggregate PnL, win rate, etc.
}
```

---

### 2B-6. Wallet + Execution

```typescript
// src/execution/wallet.ts
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`)
```

```typescript
// src/execution/order.ts
async function executeOrder(setup: ActiveSetup, wallet): Promise<OrderResult> {
  // 1. Calculate position size (Section 12 formula)
  // 2. Round price to HL tick size (szDecimals from meta)
  // 3. Check minimum order size
  // 4. Sign with viem (EIP-712)
  // 5. Submit via ExchangeClient
  // 6. Return order ID + log to journal
}
```

---

### 2B-7. Risk Management

Real account balance from HL (replaces Sprint 1 `SIMULATED_ACCOUNT`).

```typescript
export const RISK = {
  maxRiskPerTrade: 0.01,         // 1% of account per trade
  maxConcurrentPositions: 3,
  maxDailyLoss: 0.03,            // 3% daily max loss → PAUSE agent
  maxWeeklyLoss: 0.05,           // 5% weekly loss → PAUSE + alert
  maxPositionSize: 0.10,         // 10% of account in single position
  maxCorrelatedPositions: 2,     // max 2 correlated assets same direction
  maxTotalExposure: 3.0,         // 3x account total exposure
} as const
```

Position sizing (Section 12 formula):
```
riskAmount = accountValue × maxRiskPerTrade
stopDistance = |entryPrice - slPrice| / entryPrice
positionSize = riskAmount / stopDistance
clamp(positionSize, minOrderSize, accountValue × maxPositionSize)
```

HL-specific (Section 12.6):
- Check `szDecimals` minimum order size before placing
- Add slippage buffer (0.05-0.1% for liquid, 0.2-0.5% for illiquid)
- Verify liquidation price > stop price (safety margin)
- Factor funding rate into expected cost for long holds

---

## Phase 2C: Safety & Resilience

### 2C-1. Circuit Breakers

**Why**: Agent must protect capital. Automatic pause when things go wrong.

```typescript
// src/agent/circuit-breakers.ts

interface CircuitBreakers {
  // Daily loss limit: 3% → pause until next day
  checkDailyLoss(pnl: number, accountValue: number): boolean

  // Consecutive losses: 3 in a row → pause 2 hours
  checkConsecutiveLosses(count: number): boolean

  // Rapid loss: 2%+ in 1 hour → pause 4 hours
  checkRapidLoss(recentPnl: number, window: number): boolean

  // Max drawdown from peak: 10% → pause + alert owner
  checkMaxDrawdown(currentValue: number, peakValue: number): boolean
}
```

---

### 2C-2. Anti-Correlation Guard

**Why**: BTC long + ETH long = effectively 2x the same bet.

```typescript
// src/agent/correlation-guard.ts

// Block or warn when opening correlated positions
// BTC/ETH correlation > 0.8 → count as 1 position for exposure
// If already long BTC, long ETH signal → reduce size or skip
```

---

### 2C-3. Self-Healing

**Why**: Agent runs 24/7. Must recover from transient failures.

```typescript
// src/agent/self-healing.ts

// WS disconnect → auto-reconnect (already in Sprint 1)
// DB connection lost → retry with backoff, queue writes
// Order API error → retry 2x, then skip + alert
// Exchange maintenance → detect 503, pause agent, resume when healthy
// Memory leak → monitor RSS, restart if > threshold
```

---

## Phase 2D: Notifications

### 2D-1. Telegram Alerts

```typescript
// src/alert/telegram.ts
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID = process.env.TELEGRAM_CHAT_ID

async function sendTelegramAlert(message: string): Promise<void>
```

Alert types:
- SETUP detected (grade A/A+)
- ORDER filled
- POSITION closed (with PnL)
- CIRCUIT BREAKER tripped
- INVALID pattern (if position affected)
- Daily P&L summary

---

### 2D-2. Sound Alerts

```typescript
function soundAlert(): void {
  process.stdout.write('\x07')  // BEL character
}
```

Trigger on SETUP detection (grade B+) and circuit breaker events.

---

### 2D-3. Fancy Terminal UI

ANSI escape codes (no dependency):
- Green LONG, Red SHORT, Yellow WARNING, Dim STATUS
- Bold SETUP alerts with confluence grade badge
- Agent state indicator: `[IDLE]` `[WATCHING]` `[IN_POSITION]` `[PAUSED]`
- Live P&L display

---

## Phase 2E: Enhancements (Sprint 2 late or Sprint 3)

### 2E-1. Regime Lag Warning

Alert when Indicator-Based regime (detectRegime → BULL) conflicts with Wyckoff phase (Distribution).

```
[WARNING] BTC | Regime BULL but Wyckoff Distribution — regime may be lagging
```

### 2E-2. Web Dashboard

Elysia SSE + lightweight frontend. Chart with zones, setups, structure overlaid.

---

## Sprint 2 Priority Order

```
Phase 2A: Infrastructure
  1. PostgreSQL + TimescaleDB     ← foundation for everything
  2. Exit strategies              ← unblocks agent execution
  3. Elysia HTTP server           ← API access + execution control

Phase 2B: Agent Core
  4. Agent State Machine          ← heart of the agent
  5. Order Lifecycle Manager      ← place/fill/reject/cancel/timeout
  6. Position Monitor             ← trail stop, partial close, exit
  7. Invalidation → Action Bridge ← pattern invalid → cancel/close
  8. Trade Journal                ← audit every decision
  9. Wallet + Execution           ← sign and submit orders
  10. Risk Management             ← position sizing, real account balance

Phase 2C: Safety
  11. Circuit Breakers            ← protect capital automatically
  12. Anti-Correlation Guard      ← block correlated positions
  13. Self-Healing                ← recover from transient failures

Phase 2D: Notifications
  14. Telegram alerts             ← remote notifications
  15. Sound alerts                ← local notifications
  16. Fancy terminal UI           ← visual polish

Phase 2E: Enhancements (late Sprint 2 or Sprint 3)
  17. Regime lag warning
  18. Web dashboard
```

---

## Session Roadmap

Map phases to sessions. Each session = 1 Task Contract, 20-45 min, checkpoint commit before/after.

**Rule**: Only detail the next 2-3 sessions. Re-plan after each phase completes.

### Phase 2A: Infrastructure (Sessions 1-4)

| Session | Task | Items | Est. | Dependencies |
|---|---|---|---|---|
| S1 | PostgreSQL + TimescaleDB setup | Schema, docker-compose.yml (R7), numbered SQL migrations (R13), connection pool max:5 (R15), simple log helper (R6) | 30-40 min | Docker installed |
| S2 | Candle persistence layer | Sync write-through (R14), gap-fill on restart, PG ↔ in-memory store | 30-40 min | S1 |
| S3 | Exit strategies | SL/TP computation, trail/partial types, extract computePositionSize (R12) | 25-35 min | None (pure functions) |
| S4 | Elysia HTTP server | Routes, validation, bearer auth, localhost-only binding (R4) | 30-40 min | S1 (DB queries) |

### Phase 2B: Agent Core (Sessions 5-10)

| Session | Task | Items | Est. | Dependencies |
|---|---|---|---|---|
| S5 | Agent State Machine | State-handler pattern (R2), EventEmitter pipeline wiring (R10), crash recovery (R1) | 35-45 min | S2, S3 |
| S6 | Order Lifecycle Manager | Place/fill/reject/cancel/timeout, HL trigger orders for SL/TP (R9), idempotency key | 30-40 min | S5 |
| S7 | Position Monitor | Trail stop, partial close, exchange-sync heartbeat ~10s (R3) | 30-40 min | S5, S6 |
| S8 | Invalidation → Action Bridge | Pattern invalid → cancel/close | 20-30 min | S5, S6 |
| S9 | Trade Journal | Log decisions to PostgreSQL | 20-30 min | S1 |
| S10 | Wallet + Execution + Risk Mgmt | viem, order signing, assessRisk accountValue param (R11), remove SIMULATED_ACCOUNT (R17) | 35-45 min | S5, S6 |

### Phase 2C: Safety (Sessions 11-13)

| Session | Task | Items | Est. | Dependencies |
|---|---|---|---|---|
| S11 | Circuit Breakers | Daily loss, consecutive loss, rapid loss, max drawdown. CB holds position with SL/TP (R5) | 25-35 min | S5, S9 |
| S12 | Anti-Correlation Guard | Correlated position detection + blocking | 20-30 min | S5 |
| S13 | Self-Healing | Reconnect, retry, queue, health check | 25-35 min | S4, S6 |

### Phase 2D: Notifications (Sessions 14-15)

| Session | Task | Items | Est. | Dependencies |
|---|---|---|---|---|
| S14 | Telegram alerts | Bot setup, alert types, formatting | 20-30 min | S5 |
| S15 | Terminal UI + Sound | ANSI formatting, agent state display, BEL | 20-30 min | S5 |

### Phase 2E: Integration (Session 16)

| Session | Task | Items | Est. | Dependencies |
|---|---|---|---|---|
| S16 | End-to-end integration test | Full agent loop on testnet, 24h soak test | 45-60 min | All above |

**Total: ~16 sessions, ~8-10 hours estimated**

### Session Progress

| Session | Status | Date | Notes |
|---|---|---|---|
| S1 | DONE | 2026-03-30 | Docker Compose, 001_initial.sql (4 tables + 2 hypertables + matview), connection pool, migration runner, logger. pnl_hourly changed from continuous aggregate to regular matview (positions is not a hypertable). |
| S2 | DONE | 2026-03-30 | candle-repo (upsert, bulk upsert, load, getAllLastTimestamps, gap-fill helpers), store.ts onPersist callback, index.ts PG-aware startup (load→gap-fill→backfill→wire write-through), TIMEFRAME_MS config, closeDb on SIGINT. 244 tests pass. |
| S3 | DONE | 2026-03-30 | exits.ts: computePositionSize (R12), structure/ATR/combined SL, R:R + structure TP, trailing stop, partial close, buildExitPlan. Risk-filter refactored to shared computePositionSize. 42 new tests, 286 total pass. |

---

## Definition of Done

Sprint 2 is complete when:
- [ ] PostgreSQL + TimescaleDB: candles persisted, restart gap-fill < 1s
- [ ] Agent State Machine: full lifecycle IDLE → WATCHING → ENTERING → IN_POSITION → EXITING
- [ ] Order Lifecycle: place, fill, reject, cancel, timeout all handled
- [ ] Position Monitor: trail stop, partial close working
- [ ] Invalidation Bridge: pattern invalid → order cancelled / position closed
- [ ] Trade Journal: every decision logged with reason
- [ ] Risk Management: position size auto-calculated from real account balance
- [ ] Circuit Breakers: daily loss pause, consecutive loss pause working
- [ ] Section 12 rules enforced: stop placement, minimum R:R, skip conditions
- [ ] Telegram: critical alerts arrive within 5s
- [ ] Elysia: all endpoints respond, execution endpoints auth-protected
- [ ] All Sprint 1 tests still pass
- [ ] New agent + execution tests pass
- [ ] Agent runs autonomously for 24h on testnet without human intervention

### Carried from Sprint 1 `[CARRIED]`

These items were not live-verified in Sprint 1 (covered by unit tests only). Will naturally verify during Sprint 2 agent testing:
- [ ] SETUP alerts show grade (B/A/A+), layer count, VSA/VP boosts
- [ ] Each STOP point verified: neutral bias → no scan, structure deny → no zones
- [ ] HTF gate works: LTF counter-HTF signals blocked
- [ ] Staleness WARNING fires when WiFi disconnected 60s
