# Minh (明) — Sprint 4.5: ISOLATE — Multi-Strategy Architecture + Agent Wallets

## Goal

Refactor system architecture to support **multiple trading strategies running simultaneously**, each with its own Hyperliquid agent wallet, independent risk management, and per-strategy PnL tracking. Make adding new strategies (e.g., SMC+S&D zone bounce) a 3-step process: implement interface, register, add wallet.

**Sprint 4.5 = ISOLATE. Each strategy operates independently on shared market data.**

### Sprint Progression

```
Sprint 1: SEE        ✅ → Analysis engine (pipeline, indicators, structure)
Sprint 2: ACT        ✅ → Agent execution (state machine, orders, risk, safety)
Sprint 3: VALIDATE   ✅ → Backtest + Analytics + Dashboard MVP
Sprint 4: EXPAND     ✅ → Telegram + Dashboard extensions + tech debt
Sprint 4.5: ISOLATE  🔲 → Multi-Strategy + Agent Wallets
Sprint 5: ADVISE     🔲 → Basic LLM Advisor (gate: >= 100 trades)
Sprint 6: REMEMBER I 🔲 → Memory foundation (Layered + RAG)
Sprint 7: REMEMBER II🔲 → Memory intelligence (Graph + HyDE + Learning)
```

---

## Kickoff Review Summary

### Sprint 4 DoD: ALL CONFIRMED
- 4A Tech Debt: 3/3 CONFIRMED (936 pass, error boundaries, smoke test)
- 4B Telegram Bot: 6/6 CONFIRMED (/help, /status, /pnl, /pause, /resume, /closeall)
- 4C Dashboard Extensions: 4/4 CONFIRMED (backtest browser, comparison, journal, mobile)
- Always: 3/3 CONFIRMED (all Sprint 1-3 tests pass, 58 new tests)

### CEO Review Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| V1 | Strategy dispatch | **Fan-out registry** | Replace global `activeStrategy` mutable. All registered strategies run per tick. No switch/case |
| V2 | Agent state key | **`coin:strategyId`** | Same coin can be traded by different strategies simultaneously (independent signals) |
| V3 | Exchange isolation | **Agent wallet per strategy** | Each strategy signs with own HL agent wallet. Software-enforced capital allocation (HL agent wallets share main account balance) |
| V4 | DB migration | **`strategy_id TEXT DEFAULT 'layered'`** | Additive columns on existing tables. Zero data migration. Backward compatible |
| V5 | Single-strategy compat | **Feature flag via `STRATEGY_WALLETS` env** | No env var = single wallet mode (Sprint 4 behavior unchanged) |
| V6 | Risk isolation | **Per-strategy CB + portfolio cap** | Each strategy has own daily PnL limit + circuit breakers. Global exposure cap prevents over-leverage |
| V7 | Correlation guard | **Cross-strategy allowed (independent)** | Different strategies CAN hold same coin same direction. They're independent signals |
| V8 | Capital allocation | **Fixed % per strategy in config** | e.g., quant=40%, smc-sd=60%. PositionSizer uses allocated capital, not total balance |

### Eng Review Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| E25 | ExchangeService parameterization | **Constructor injection** with optional WalletConfig | Minimal diff, explicit > clever. Fallback to env if no config |
| E26 | Setup event routing | **Single emitter + strategyId in ActiveSetup** | DRY — one emitter, agent filters by setup.strategyId |
| E27 | PipelineStats isolation | **Per-strategy stats Map** | Explicit, no stat inflation. Backtest + dashboard filter by strategy |
| E28 | Agent file structure | **Extract orchestrator to separate file** | 776L + new per-strategy logic warrants split |
| E29 | Schema debt fix | **Fix cloid + fill_size in migration 005** | One migration clears 2 existing TODOs |
| E30 | Strategy removal guard | **Block disable if open positions** | Must close positions before removing strategy |

### Review Stats
- CEO: 0 critical gaps, 8 failure modes mapped, 1 edge case resolved (strategy removal)
- Eng: 6 issues resolved across 4 sections, 0 critical gaps
- Test plan: 4 new test files + 3 extended, ~60-80 new tests
- Failure modes: 8 mapped, 0 silent failures

---

## Architecture

### Before (Sprint 4)

```
Feed (shared) → Global activeStrategy (1 at a time) → Pipeline → Agent (per-coin)
                         ↓
              ExchangeService (singleton, 1 wallet)
```

### After (Sprint 4.5)

```
Feed Layer (shared — candles, L2, trades, funding)
    ↓
StrategyRegistry.runAll() — fan-out to ALL registered strategies
    ↓
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Layered Strategy │  │ Quant Strategy  │  │ Future Strategy │
│ (5-layer Wyckoff)│  │ (EMA+RSI)       │  │ (SMC+S&D)       │
│ Agent Wallet A   │  │ Agent Wallet B  │  │ Agent Wallet C  │
│ 50% allocation   │  │ 50% allocation  │  │ % allocation    │
│ Own GlobalContext │  │ Own GlobalContext│  │ Own GlobalContext│
│ Own CircuitBreaker│  │ Own CircuitBreaker│ │ Own CircuitBreaker│
└────────┬─────────┘  └────────┬─────────┘  └────────┬────────┘
         └────────────────┬────┘                      │
                    PortfolioRiskManager ──────────────┘
                    (global exposure cap)
```

### IStrategy Interface

```typescript
// src/scanner/strategy.ts (NEW)
export interface IStrategy {
  readonly id: string                    // 'layered' | 'quant' | 'smc-sd'
  readonly name: string                  // human-readable display name
  readonly patternTypes: PatternType[]   // patterns this strategy emits

  /** Pure scan function. Called per tick. Returns Signal or null. Zero I/O. */
  scan(coin: string, interval: CandleInterval, candles: Candle[], idx: number): Signal | null

  /** Minimum candles needed before scan is valid. */
  minCandles(): number

  /** Clear any module-level state (for backtest reset). */
  clearState(): void
}
```

### HL Agent Wallet Reality

HL agent wallets share the main account balance. Capital allocation is **software-enforced**:

```
Main Account (0x...owner) — holds ALL USDC
  ├─ Agent Wallet A (0x...quant)   — signs quant orders, allocation=50%
  ├─ Agent Wallet B (0x...smc-sd)  — signs smc-sd orders, allocation=50%
  └─ PortfolioRiskManager: tracks total exposure across all strategies
```

Risk: Strategy A losing heavily reduces shared balance, affecting Strategy B's effective capital. Mitigated by per-strategy daily loss limit + auto-pause.

---

## Scope

### Phase 4.5A: Foundation (Sessions S1-S3)

#### S1: Strategy Interface + Registry

| Item | Description | Files |
|------|-------------|-------|
| IStrategy interface | Pure scan function contract | `src/scanner/strategy.ts` (NEW) |
| StrategyRegistry | register/getAll/get/runAll | `src/scanner/strategy.ts` (NEW) |
| LayeredAdapter | Wrap existing `runPipeline` | `src/scanner/strategies/layered-adapter.ts` (NEW) |
| QuantAdapter | Wrap existing `runQuantPipeline` | `src/scanner/strategies/quant-adapter.ts` (NEW) |
| Type extensions | `strategyId` on ActiveSetup, extend StrategyType | `src/types.ts`, `src/backtest/types.ts` |
| Tests | Registry CRUD, fan-out, adapters | `test/strategy-registry.test.ts` (NEW) |

#### S2: Pipeline Refactor — Remove Global State

| Item | Description | Files |
|------|-------------|-------|
| Remove globals | Delete `activeStrategy`, `setStrategy()`, `getStrategy()` | `src/scanner/pipeline.ts` |
| Fan-out dispatch | `onCandleTick` → `registry.runAll()` | `src/scanner/pipeline.ts` |
| Setup key update | `activeSetups` keyed by `strategyId:coin\|tf\|type` | `src/scanner/pipeline.ts` |
| Invalidation update | `setupId()` includes strategyId | `src/scanner/invalidation.ts` |
| Per-strategy stats | `PipelineStats` per strategy (not shared) | `src/scanner/pipeline.ts` |
| Tests | All existing pipeline tests pass + new fan-out tests | `test/pipeline.test.ts` |

#### S3: Database Migration

| Item | Description | Files |
|------|-------------|-------|
| strategies table | id, name, enabled, config, wallet_address, capital_allocation | `src/db/migrations/005_strategies.sql` (NEW) |
| Extend orders | `ADD COLUMN strategy_id TEXT DEFAULT 'layered'` | `src/db/migrations/005_strategies.sql` |
| Extend positions | `ADD COLUMN strategy_id TEXT DEFAULT 'layered'` | `src/db/migrations/005_strategies.sql` |
| Extend trade_journal | `ADD COLUMN strategy_id TEXT` | `src/db/migrations/005_strategies.sql` |
| Fix schema debt (E29) | Add `cloid TEXT` + `fill_size DOUBLE PRECISION` to orders | `src/db/migrations/005_strategies.sql` |
| Indexes | `idx_orders_strategy`, `idx_positions_strategy` | `src/db/migrations/005_strategies.sql` |
| Tests | Migration applies, existing rows default 'layered' | `test/db/migration-005.test.ts` |

### Phase 4.5B: Isolation (Sessions S4-S6)

#### S4: Exchange Pool + Per-Strategy Wallets

| Item | Description | Files |
|------|-------------|-------|
| ExchangeService params | Constructor accepts wallet config (not just env) | `src/execution/exchange-service.ts` |
| ExchangePool | Factory: `Map<strategyId, ExchangeService>` | `src/execution/exchange-pool.ts` (NEW) |
| Wallet config | Parse `STRATEGY_WALLETS` JSON env var | `src/config.ts` |
| Single-wallet fallback | No env → shared instance for all strategies | `src/execution/exchange-pool.ts` |
| Tests | Pool creates separate instances, single-wallet compat | `test/exchange-pool.test.ts` (NEW) |

#### S5: Agent State Machine — Per-Strategy

| Item | Description | Files |
|------|-------------|-------|
| CoinContext.strategyId | Add strategyId field | `src/agent/types.ts` |
| State map key | `coin:strategyId` (not just `coin`) | `src/agent/trading-agent.ts` |
| Per-strategy GlobalContext | `Map<strategyId, GlobalContext>` | `src/agent/trading-agent.ts` |
| Per-strategy circuit breakers | Daily PnL tracking per strategy | `src/agent/circuit-breakers.ts` |
| Extract orchestrator (E28) | Split orchestrator from pure handlers | `src/agent/trading-orchestrator.ts` (NEW) |
| Tests | Same coin, different strategies → independent states | `test/agent/multi-strategy.test.ts` (NEW) |

#### S6: Portfolio Risk Manager

| Item | Description | Files |
|------|-------------|-------|
| PortfolioRiskManager | Aggregate risk across all strategies | `src/agent/portfolio-risk.ts` (NEW) |
| Config constants | maxTotalExposure, maxTotalConcurrent, per-strategy caps | `src/config.ts` |
| Integration hook | Check portfolio risk before place_order action | `src/agent/trading-agent.ts` |
| Tests | Portfolio cap blocks entry when over-exposed | `test/agent/portfolio-risk.test.ts` (NEW) |

### Phase 4.5C: Integration + Backtest (Sessions S7-S8)

#### S7: Wire Everything in index.ts

| Item | Description | Files |
|------|-------------|-------|
| Startup flow | Register strategies → create pool → start agents | `src/index.ts` |
| OrderManager routing | Route to correct ExchangeService by strategy_id | `src/agent/order-manager.ts` |
| PositionMonitor | Use strategy-specific exchange instance | `src/agent/position-monitor.ts` |
| DB writes | Write strategy_id on all order/position/journal inserts | `src/agent/order-manager.ts`, `src/db/` |
| API endpoints | Accept `?strategy=` filter param | `src/server/index.ts` |
| New endpoint | `GET /api/strategies` — list registered strategies | `src/server/index.ts` |

#### S8: Backtest Multi-Strategy

| Item | Description | Files |
|------|-------------|-------|
| Strategy selection | `registry.activateOnly(strategyId)` for isolated backtest | `src/backtest/engine.ts` |
| BacktestTrade.strategyId | Track which strategy generated each trade | `src/backtest/types.ts` |
| Per-strategy WFA | Walk-forward per strategy | `src/backtest/walk-forward.ts` |
| Tests | Backtest quant-only = same results as before | `test/backtest/` |

### Phase 4.5D: UI + Docs (Sessions S9-S10)

#### S9: Dashboard + Telegram

| Item | Description | Files |
|------|-------------|-------|
| Strategy selector | Global dropdown filter on all dashboard pages | `dashboard/src/components/StrategySelector.tsx` (NEW) |
| Telegram /strategy | list, status, pause, resume commands | `src/alert/telegram/commands.ts` |
| API strategy filter | All endpoints accept `strategy_id` param | `src/server/index.ts` |

#### S10: Docs + Sprint 5 Update

| Item | Description | Files |
|------|-------------|-------|
| Sprint 5 update | Reference strategy_id in LLM analysis queries | `docs/plan/sprint-5.md` |
| Architecture doc | Updated diagram with multi-strategy flow | `docs/spec/architecture.md` |
| Decision log | V1-V8 decisions logged | `docs/plan/decisions.md` |

---

## Session Progress

| # | Session | Status | Date | Notes |
|---|---------|--------|------|-------|
| S1 | Strategy Interface + Registry | DONE | 2026-04-02 | IStrategy + Registry + 2 adapters + 35 tests, 1013 total pass |
| S2 | Pipeline Refactor | DONE | 2026-04-06 | Remove global state, fan-out via StrategyRegistry, per-strategy stats |
| S3 | DB Migration 005 | DONE | 2026-04-06 | strategies table + strategy_id on 3 tables + cloid/fill_size E29 fix, 1023 tests pass |
| S4 | Exchange Pool + Wallets | DONE | 2026-04-06 | WalletConfig + ExchangePool + single-wallet fallback, 1050 tests pass |
| S5 | Agent State Per-Strategy | DONE | 2026-04-06 | E28 orchestrator extraction, coin:strategyId key, per-strategy GlobalContext+CB, 25 new tests, 1075 total pass |
| S6 | Portfolio Risk Manager | DONE | 2026-04-06 | PortfolioRiskManager pure functions + config + orchestrator hook, 19 new tests, 1094 total pass |
| S7 | Integration Wiring | | | |
| S8 | Backtest Multi-Strategy | | | |
| S9 | Dashboard + Telegram | | | |
| S10 | Docs + Sprint 5 Update | | | |

---

## Definition of Done

### Phase 4.5A: Foundation
- [x] `IStrategy` interface defined with scan/minCandles/clearState (S1)
- [x] `StrategyRegistry` with register/getAll/runAll fan-out (S1)
- [x] `LayeredStrategyAdapter` wraps existing pipeline (no logic change) (S1)
- [x] `QuantStrategyAdapter` wraps existing quant-pipeline (no logic change) (S1)
- [x] `activeSetups` keyed by `strategyId:coin|tf|type` (S2)
- [x] `setupId()` includes strategyId (S2)
- [x] Migration 005 applies cleanly (additive, backward compat) [CONFIRMED] (S3)
- [x] All existing tests pass unchanged — 1023 pass (S3)

### Phase 4.5B: Isolation
- [x] `ExchangePool` creates per-strategy ExchangeService instances (S4)
- [x] Single-wallet mode (no `STRATEGY_WALLETS` env) backward compatible (S4)
- [x] Agent state keyed by `coin:strategyId` (S5)
- [x] Per-strategy `GlobalContext` (dailyPnl, circuit breakers independent) (S5)
- [x] `PortfolioRiskManager` enforces global exposure cap (S6)
- [x] Tests: same coin, different strategies → fully independent states (S5)

### Phase 4.5C: Integration
- [ ] `index.ts` startup registers strategies, creates exchange pool, starts per-strategy agents
- [ ] OrderManager routes to correct ExchangeService by strategy_id
- [ ] strategy_id written to orders/positions/trade_journal on all DB writes
- [ ] Backtest works per-strategy (isolated, same results as before)
- [ ] API endpoints accept `?strategy=` filter

### Phase 4.5D: UI + Docs
- [ ] Dashboard strategy selector dropdown on all pages
- [ ] Telegram `/strategy` commands functional
- [ ] `docs/spec/architecture.md` updated with multi-strategy diagram
- [ ] `docs/plan/sprint-5.md` references strategy_id in analysis queries
- [ ] `decisions.md` logged with V1-V8

### Always
- [ ] `bun test --run` — ALL tests pass (Sprint 1-4 + new)
- [ ] No `any` without justification comment
- [ ] No magic numbers — all thresholds in `config.ts`
- [ ] Pure function boundary maintained (scanner/ and indicators/ zero I/O)
- [ ] No secrets in code

---

## Existing Code Reuse Map

| Sub-problem | Existing code | File |
|---|---|---|
| Layered pipeline scan | `runPipeline()` | `src/scanner/pipeline.ts` |
| Quant pipeline scan | `runQuantPipeline()` | `src/scanner/quant-pipeline.ts` |
| Pipeline event emitter | `getPipelineEmitter()` | `src/scanner/pipeline.ts` |
| Candle feed store | `getCandles()`, `appendCandle()` | `src/feed/store.ts` |
| Exchange service class | `ExchangeService` | `src/execution/exchange-service.ts` |
| Agent state handlers | `handleIdle()`, etc. | `src/agent/trading-agent.ts` |
| Circuit breakers | `runAllChecks()` | `src/agent/circuit-breakers.ts` |
| Position sizing | `computePositionSize()` | `src/agent/exits.ts` |
| Risk filter | `assessRisk()` | `src/scanner/risk-filter.ts` |
| Setup invalidation | `isInvalidated()`, `setupId()` | `src/scanner/invalidation.ts` |
| Confluence scoring | `scoreConfluence()` | `src/scanner/confluence.ts` |
| Regime filter | `applyRegimeModifier()` | `src/scanner/regime.ts` |
| DB connection | `getPool()`, `runMigrations()` | `src/db/connection.ts`, `src/db/migrate.ts` |

## NOT in Scope

- Implementing SMC+S&D strategy logic (separate sprint/session after architecture is ready)
- On-chain capital isolation (HL does not support per-agent-wallet balance separation)
- Multi-exchange support (Hyperliquid only, per S7 decision)
- Dynamic capital rebalancing between strategies (fixed % allocation only)
- Strategy optimization/auto-tuning (Sprint 5 LLM advisor scope)
- Dashboard E2E tests (Playwright deferred)

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing tests | High | Adapter pattern — wrap, don't rewrite. Run `bun test --run` every session |
| Shared balance drain | High | Per-strategy daily loss limit + auto-pause. PortfolioRiskManager global cap |
| Pipeline state contamination | Medium | Per-strategy PipelineStats. Clear on backtest. Isolated activeSetups key |
| Agent wallet expiry | Medium | HL agent wallets expire. Document check + renewal flow. Alert on expiry |
| Order routing to wrong wallet | Critical | ExchangePool keyed by strategyId. Unit test routing correctness |
| Migration failure on live DB | Medium | `IF NOT EXISTS` + `DEFAULT` clauses. Test on empty + populated DB |
| Dashboard complexity increase | Low | Strategy selector is global filter, not new pages. Minimal UI change |

## Session Estimates

| Session | Task | Exchanges | Duration |
|---------|------|-----------|----------|
| S1 | Strategy Interface + Registry | 12-15 | 30-40 min |
| S2 | Pipeline Refactor (remove global state) | 15-18 | 35-45 min |
| S3 | DB Migration 005 | 8-10 | 20-25 min |
| S4 | Exchange Pool + Wallet Config | 12-15 | 30-40 min |
| S5 | Agent State Per-Strategy | 15-18 | 35-45 min |
| S6 | Portfolio Risk Manager | 10-12 | 25-30 min |
| S7 | Integration Wiring (index.ts) | 15-18 | 35-45 min |
| S8 | Backtest Multi-Strategy | 12-15 | 30-40 min |
| S9 | Dashboard + Telegram | 12-15 | 30-40 min |
| S10 | Docs + Sprint 5 Update | 6-8 | 15-20 min |
| **Total** | | **~130** | **~5.5-6.5 hours** |
