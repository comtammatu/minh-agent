# Minh (明) — Sprint 2: Trading + Infrastructure

## Goal

Add order execution capability, persistence, HTTP API, and alerting infrastructure on top of the Sprint 1 layered analysis engine.

**Sprint 2 = execution + infrastructure. Analysis engine (Sprint 1) is foundation.**

---

## Phase 2A: Infrastructure

### 2A-1. SQLite Persistence

**Why**: Eliminate cold start backfill time. Candle store survives restart.

**Approach**: `bun:sqlite` (built-in, zero deps)

```typescript
// feed/sqlite.ts
class SQLiteStore {
  constructor(dbPath: string)  // default: ./data/minh.db

  saveCandles(coin, interval, candles: Candle[]): void
  loadCandles(coin, interval): Candle[]
  getLastTimestamp(coin, interval): number | null
}
```

**Schema**:
```sql
CREATE TABLE candles (
  coin TEXT NOT NULL,
  interval TEXT NOT NULL,
  t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  PRIMARY KEY (coin, interval, t)
);
```

**Startup flow change**:
```
Before (Sprint 1): REST backfill ALL 5000 × 18 + Readiness Gate
After:
  1. Load SQLite → memory
  2. For each coin/tf: REST gap-fill (lastTimestamp → now) — only missing candles
  3. Readiness Gate + WS subscribe
  Typical: ~1s (if restarted within hours)
```

Save strategy: flush to SQLite on SIGINT + every 5 minutes.

---

### 2A-2. Elysia HTTP Server

**Why**: Programmatic access to analysis state. Foundation for web dashboard.

```
GET /health     → { status, uptime, coins, tfs, activeSetups }
GET /status     → { coins: [{ coin, regimes, bias, confluenceGrades, setupCount }] }
GET /setups     → { setups: [{ id, coin, interval, type, side, entry, sl, tp, grade, confidence }] }
GET /structure/:coin/:tf → { bias, biasConfidence, swings, demandZones, supplyZones, regime }
GET /candles/:coin/:tf?count=200 → { candles: [...] }
```

Pure read endpoints. CORS enabled for local frontend.

---

### 2A-3. Exit Strategies

**Why**: SL/TP computation needed for order execution.

```
Exit types:
  structure: SL/TP from nearest zones (already in risk-filter.ts)
  atr: SL = entry ± ATR×N
  rr-ratio: TP = entry + (entry - SL) × ratio
  trailing: activate at +X%, trail at Y%
  partial-close: close 50% at first TP, trail rest
```

Section 12 rules from domain knowledge (structure stop > ATR stop > trailing):
- Stop placement = invalidation level, NOT "comfortable" level
- Position size adjusts to stop distance, never the other way

---

### 2A-4. Fancy Terminal UI

ANSI escape codes (no dependency):
- Green LONG, Red SHORT, Yellow WARNING, Dim STATUS
- Bold SETUP alerts with confluence grade badge
- Box drawing for setup detail cards

---

## Phase 2B: Execution

### 2B-1. viem Wallet Integration

```typescript
// src/wallet.ts
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`)
```

Security: `.env` file, `.gitignore` includes `.env`.

---

### 2B-2. Order Execution

```typescript
// src/execution/order.ts
async function placeOrder(setup: ActiveSetup, wallet): Promise<OrderResult> {
  // 1. Calculate position size from risk management (Section 12)
  // 2. Round price to HL tick size (szDecimals from meta)
  // 3. Check minimum order size
  // 4. Sign with viem (EIP-712)
  // 5. Submit via ExchangeClient
  // 6. Return order ID
}
```

Config: `AUTO_EXECUTE = false` default. When false → "ORDER READY" prompt, await `y/n`.

---

### 2B-3. Position Tracking

```typescript
// src/execution/positions.ts
interface Position {
  coin: string; side: 'long' | 'short'
  entryPrice: number; size: number
  unrealizedPnl: number; margin: number
}

// Fetch from HL clearinghouseState
async function getPositions(): Promise<Position[]>
```

Poll every 30s or on fill event.

---

### 2B-4. Setup → Order Bridge

```
Pipeline detects setup (grade B+) →
  If AUTO_EXECUTE:
    → Calculate position size (Section 12 risk rules)
    → Place limit order at setup.entryPrice
    → Set SL/TP orders
    → Track in position manager
  If manual:
    → Print "ORDER READY | BTC 4H LONG OB | grade:A | entry:67250 size:0.1 | [y/n]"
    → Await stdin
    → On 'y': execute
```

---

### 2B-5. Risk Management

Replace Sprint 1 `SIMULATED_ACCOUNT` with real account balance from HL.

```typescript
export const RISK = {
  maxRiskPerTrade: 0.01,         // 1% of account per trade
  maxConcurrentPositions: 3,
  maxDailyLoss: 0.03,            // 3% daily max loss → stop trading
  maxWeeklyLoss: 0.05,           // 5% weekly loss → review
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

### 2B-6. Telegram Alerts

```typescript
// src/alert/telegram.ts
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID = process.env.TELEGRAM_CHAT_ID

async function sendTelegramAlert(message: string): Promise<void>
```

Alert types: SETUP detected, ORDER filled, INVALID, daily P&L summary.

---

### 2B-7. Sound Alerts

```typescript
function soundAlert(): void {
  process.stdout.write('\x07')  // BEL character
}
```

Trigger on SETUP detection only (grade B+).

---

## Phase 2C: Enhancements

### 2C-1. Regime Lag Warning

Alert when Indicator-Based regime (detectRegime → BULL) conflicts with Wyckoff phase (Distribution). This is a leading signal that regime is about to change.

```
[WARNING] BTC | Regime BULL but Wyckoff Distribution — regime may be lagging
```

### 2C-2. Multi-Exchange (CCXT)

Abstract feed layer behind interface:
```typescript
interface FeedProvider {
  fetchCandles(coin, interval, start, end): Promise<Candle[]>
  subscribeCandles(coin, interval, onCandle): Promise<() => void>
}

class HyperliquidFeed implements FeedProvider { ... }  // existing
class CCXTFeed implements FeedProvider { ... }          // new
```

Deferred to Sprint 2 late or Sprint 3.

### 2C-3. Web Dashboard

Elysia SSE + htmx (or lightweight React). Chart with zones, setups, structure overlaid.

Deferred to Sprint 3. Terminal + Telegram sufficient initially.

---

## Sprint 2 Priority Order

```
1. SQLite persistence        ← fast restart
2. Exit strategies           ← unblocks execution
3. Risk management           ← unblocks execution (upgrade risk-filter.ts to real account)
4. viem wallet               ← unblocks execution
5. Order execution           ← core Sprint 2 feature
6. Position tracking         ← monitors executed orders
7. Setup→Order bridge        ← connects pipeline to execution
8. Elysia server             ← API access
9. Telegram alerts           ← remote notifications
10. Sound alerts             ← local notifications
11. Fancy terminal           ← visual polish
12. Regime lag warning        ← quality enhancement
13. Multi-exchange           ← Sprint 2 late or Sprint 3
14. Web dashboard            ← Sprint 3
```

## Definition of Done

Sprint 2 is complete when:
- [ ] SQLite: restart in < 1s (vs 9s+ cold)
- [ ] Order execution: manual mode works (y/n prompt)
- [ ] Risk management: position size auto-calculated from real account balance
- [ ] Section 12 rules enforced: stop placement, minimum R:R, skip conditions
- [ ] Position tracking: live PnL visible
- [ ] Telegram: SETUP alert arrives within 5s
- [ ] All Sprint 1 tests still pass
- [ ] New execution tests pass
