/**
 * Trading Orchestrator — canonical single-context runtime state.
 *
 * Pure handlers remain in trading-agent.ts. This file owns the orchestrator class.
 */

import { EventEmitter } from "node:events";
import {
  type AdvisorSnapshot,
  evaluateSetup,
  isSnapshotFresh,
  type SetupDims,
} from "../advisor/index.js";
import { type AdvisorMode, DEFAULT_RISK_PERCENT } from "../config.js";
import { log } from "../lib/logger.js";
import type { ActiveSetup, MarketRegime } from "../types.js";
import { prunePnlHistory, runAllChecks } from "./circuit-breakers.js";
import { shouldBlockCorrelatedEntry } from "./correlation-guard.js";
import {
  checkPortfolioEntry,
  type PortfolioPosition,
} from "./portfolio-risk.js";
import { handlers } from "./trading-agent.js";
import type {
  AgentAction,
  AgentEvent,
  AgentSnapshot,
  AgentState,
  CoinContext,
  GlobalContext,
} from "./types.js";

function createGlobalContext(startedAt: number): GlobalContext {
  return {
    dailyPnl: 0,
    peakAccountValue: 0,
    totalConsecutiveLosses: 0,
    lastTradeTime: 0,
    globalPaused: false,
    globalPauseReason: null,
    startedAt,
    pnlHistory: [],
  };
}

// ─── State Key Helpers ──────────────────────────────────────────────────────

/** Build state map key from the canonical per-coin runtime state. */
export function stateKey(coin: string): string {
  return coin;
}

// ─── Trading Agent (Orchestrator) ───────────────────────────────────────────

export class TradingAgent {
  /** Per-coin state keyed by coin. */
  private coins: Map<string, CoinContext> = new Map();
  /** Shared runtime global context. */
  private global: GlobalContext;
  private emitter = new EventEmitter();
  private tradeCloseListeners: Array<(coin: string, pnl: number) => void> = [];
  private startedAt: number;
  /** Shared account equity for portfolio risk checks (updated by position monitor). */
  private accountEquity = 0;
  /** Advisor snapshot provider — injected via setAdvisor(); null until runtime wires it. */
  private advisorProvider: { getSnapshot(): AdvisorSnapshot | null } | null =
    null;
  /** Advisor enforcement mode — 'off' disables the gate entirely. */
  private advisorMode: AdvisorMode = "off";

  constructor() {
    this.startedAt = Date.now();
    this.global = createGlobalContext(this.startedAt);
  }

  /** Set account equity (called by position monitor / exchange sync). */
  setAccountEquity(equity: number): void {
    this.accountEquity = equity;
  }

  /** Get current account equity. */
  getAccountEquity(): number {
    return this.accountEquity;
  }

  /** Wire the advisor stats provider + mode (called by runtime wiring at boot). */
  setAdvisor(
    provider: { getSnapshot(): AdvisorSnapshot | null },
    mode: AdvisorMode,
  ): void {
    this.advisorProvider = provider;
    this.advisorMode = mode;
  }

  // ── Pipeline Integration (R10) ───────────────────────────────────────────

  subscribeToPipeline(pipelineEmitter: EventEmitter): void {
    pipelineEmitter.on("setup", (setup: ActiveSetup) => {
      this.onSetup(setup);
    });
  }

  /** Handle incoming setup from pipeline. */
  onSetup(setup: ActiveSetup): void {
    const key = stateKey(setup.coin);
    const coinState = this.getCoinStateByKey(key);

    // Guard: skip if the coin already has a pending order or is mid-entry.
    // Without this, the pipeline re-detects the same setup every tick and spams
    // IDLE → ENTERING → order_rejected → IDLE cycles against the DB idempotency guard.
    const ctx = this.coins.get(key);
    if (ctx && (ctx.pendingOrderId || ctx.state === "ENTERING")) {
      return; // silent — duplicate setup noise is not worth logging every tick
    }

    // S12: Anti-correlation guard
    if (coinState === "IDLE" || coinState === "WATCHING") {
      const openCoins = this.getOpenPositionCoins();
      const check = shouldBlockCorrelatedEntry(setup.coin, openCoins);
      if (check.blocked) {
        log.info(
          "agent",
          `${setup.coin.padEnd(8)} SKIP correlation guard: ${check.reason}`,
        );
        this.emitter.emit(
          "action",
          journalAction("skip", setup.coin, {
            reason: check.reason,
            setupId: setup.id,
            blockedGroups: check.blockedGroups,
          }),
        );
        return;
      }
    }

    this.dispatch(setup.coin, { type: "setup_detected", setup });
  }

  // ── Event Dispatch ───────────────────────────────────────────────────────

  /** Dispatch an event to a coin state machine. */
  dispatch(
    coin: string,
    event: AgentEvent,
  ): import("./types.js").TransitionResult {
    const key = stateKey(coin);
    const ctx = this.getOrCreateCoinContext(key, coin);
    const global = this.global;
    const prevState = ctx.state;
    const handler = handlers[ctx.state];
    const result = handler(ctx, event, global);

    // Apply transition
    if (result.nextState !== prevState) {
      ctx.stateEnteredAt = Date.now();

      const setup =
        ctx.activeSetup ??
        (event.type === "setup_detected" ? event.setup : null);
      const detail = setup ? ` | ${setup.type} ${setup.side}` : "";
      const reason =
        event.type === "setup_invalidated" ? ` | reason: ${event.reason}` : "";
      log.info(
        "agent",
        `${coin.padEnd(8)} ${prevState} → ${result.nextState}${detail}${reason}`,
      );
    }
    ctx.state = result.nextState;

    // Portfolio risk check: block place_order if over-exposed (S6),
    // then advisor gate: veto / dampen from learned outcome stats (advisor v1)
    const filteredActions = this.filterByAdvisor(
      this.filterByPortfolioRisk(result.actions, coin, ctx),
      coin,
    );
    const placeOrderBlocked =
      result.actions.some((a) => a.type === "place_order") &&
      !filteredActions.some((a) => a.type === "place_order");
    if (placeOrderBlocked) {
      // place_order was blocked — stay IDLE when entry was direct from IDLE (no watch/activeSetup)
      ctx.state = prevState === "IDLE" ? "IDLE" : prevState;
      result.nextState = ctx.state;
    }

    // Log every skip journal (including portfolio-blocked and handler-emitted skips)
    for (const action of filteredActions) {
      if (action.type === "log_journal" && action.eventType === "skip") {
        const r = action.details?.reason;
        const reason =
          typeof r === "string" && r.length > 0 ? r : "(reason missing)";
        log.info("agent", `${coin.padEnd(8)} SKIP ${reason}`);
      }
    }

    // Apply event-driven context updates (once per dispatch — must run even when filteredActions is empty)
    this.applyEventContext(ctx, event);
    // Apply action-driven context updates
    for (const action of filteredActions) {
      this.applyActionContext(ctx, action);
    }

    // Emit actions for orchestrator (S6/S7)
    for (const action of filteredActions) {
      this.emitter.emit("action", action);
    }

    this.coins.set(key, ctx);
    return result;
  }

  /** Dispatch event to all coins (e.g., tick, global pause). */
  dispatchAll(event: AgentEvent): void {
    for (const [coin] of this.coins) {
      this.dispatch(coin, event);
    }
  }

  /** Tick all coins — check timeouts, cooldowns. */
  tick(): void {
    this.dispatchAll({ type: "tick" });
  }

  // ── Global Controls ──────────────────────────────────────────────────────

  /** Emergency pause the runtime. */
  pauseAll(reason: string): void {
    this.global.globalPaused = true;
    this.global.globalPauseReason = reason;
    this.dispatchAll({ type: "pause", reason });
  }

  /** Resume the runtime. */
  resumeAll(): void {
    this.global.globalPaused = false;
    this.global.globalPauseReason = null;
    this.dispatchAll({ type: "resume" });
  }

  /**
   * Update daily PnL + pnlHistory for the shared runtime.
   * Runs circuit breaker checks after recording. If tripped, pauses
   * non-IN_POSITION coins only (R5).
   */
  recordPnl(pnl: number, accountValue?: number, coin?: string): void {
    const now = Date.now();
    const g = this.global;
    g.dailyPnl += pnl;
    g.lastTradeTime = now;
    g.pnlHistory.push({ ts: now, pnl });

    if (pnl < 0) {
      g.totalConsecutiveLosses++;
    } else {
      g.totalConsecutiveLosses = 0;
    }

    if (accountValue !== undefined && accountValue > g.peakAccountValue) {
      g.peakAccountValue = accountValue;
    }

    if (accountValue !== undefined) {
      this.checkCircuitBreakers(accountValue, now);
    }

    if (coin) {
      for (const listener of this.tradeCloseListeners) {
        try {
          listener(coin, pnl);
        } catch {
          /* listeners must not crash agent */
        }
      }
    }
  }

  /** Reset daily PnL for the runtime (called at UTC midnight). */
  resetDailyPnl(): void {
    this.global.dailyPnl = 0;
  }

  /** Update account value for the shared runtime. */
  updateAccountValue(accountValue: number): void {
    const g = this.global;
    if (accountValue > g.peakAccountValue) {
      g.peakAccountValue = accountValue;
    }
  }

  /**
   * Run circuit breaker checks for the shared runtime.
   * If tripped, pause non-IN_POSITION coins only (R5).
   */
  checkCircuitBreakers(accountValue: number, now: number = Date.now()): void {
    const g = this.global;
    g.pnlHistory = prunePnlHistory(g.pnlHistory, now);

    const result = runAllChecks({
      dailyPnl: g.dailyPnl,
      accountValue,
      peakAccountValue: g.peakAccountValue,
      consecutiveLosses: g.totalConsecutiveLosses,
      pnlHistory: g.pnlHistory,
      now,
    });

    if (result.tripped && !g.globalPaused) {
      const reason = result.reason ?? "circuit_break";
      log.warn(
        "agent",
        `CIRCUIT BREAK | ${reason} | dailyPnl=$${g.dailyPnl.toFixed(2)} | pause until ${result.pauseUntil ? new Date(result.pauseUntil).toISOString().slice(11, 19) : "manual resume"}`,
      );

      g.globalPaused = true;
      g.globalPauseReason = reason;

      // Dispatch circuit_break to non-IN_POSITION coins only (R5)
      for (const [coin, ctx] of this.coins) {
        if (ctx.state !== "IN_POSITION") {
          this.dispatch(coin, {
            type: "circuit_break",
            reason,
            pauseUntil: result.pauseUntil,
          });
        }
      }

      this.emitter.emit("action", {
        type: "log_journal",
        eventType: "circuit_break",
        coin: "*",
        details: {
          reason: result.reason,
          pauseUntil: result.pauseUntil,
          dailyPnl: g.dailyPnl,
          accountValue,
          peakAccountValue: g.peakAccountValue,
        },
      });
    }
  }

  // ── Crash Recovery Skeleton (R1) ─────────────────────────────────────────

  recoverFromCrash(
    exchangePositions: Array<{
      coin: string;
      size: number;
      entryPrice: number;
    }>,
    dbPositions: Array<{ coin: string; positionId: string; side: string }>,
  ): void {
    for (const pos of exchangePositions) {
      if (Math.abs(pos.size) > 0) {
        const dbMatch = dbPositions.find((p) => p.coin === pos.coin);
        const key = stateKey(pos.coin);
        const ctx = this.getOrCreateCoinContext(key, pos.coin);
        ctx.state = "IN_POSITION";
        ctx.positionId = dbMatch?.positionId ?? `orphan-${pos.coin}`;
        ctx.stateEnteredAt = Date.now();
        this.coins.set(key, ctx);
      }
    }

    for (const dbPos of dbPositions) {
      const onExchange = exchangePositions.some(
        (p) => p.coin === dbPos.coin && Math.abs(p.size) > 0,
      );
      if (!onExchange) {
        const key = stateKey(dbPos.coin);
        const ctx = this.getOrCreateCoinContext(key, dbPos.coin);
        ctx.state = "IDLE";
        ctx.positionId = null;
        ctx.activeSetup = null;
        this.coins.set(key, ctx);
        this.emitter.emit(
          "action",
          journalAction("exit", dbPos.coin, {
            reason: "crash_recovery_closed",
            positionId: dbPos.positionId,
          }),
        );
      }
    }
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /** Get snapshot for API consumers. */
  getSnapshot(): AgentSnapshot {
    const coins: AgentSnapshot["coins"] = {};
    const now = Date.now();
    for (const [key, ctx] of this.coins) {
      coins[key] = {
        state: ctx.state,
        activeSetup: ctx.activeSetup,
        pendingOrderId: ctx.pendingOrderId,
        positionId: ctx.positionId,
        consecutiveLosses: ctx.consecutiveLosses,
        stateAge: now - ctx.stateEnteredAt,
      };
    }

    return {
      coins,
      global: {
        dailyPnl: this.global.dailyPnl,
        totalConsecutiveLosses: this.global.totalConsecutiveLosses,
        globalPaused: this.global.globalPaused,
        globalPauseReason: this.global.globalPauseReason,
        uptime: now - this.global.startedAt,
      },
    };
  }

  /** Get state for a specific coin. */
  getCoinState(coin: string): AgentState {
    const key = stateKey(coin);
    return this.coins.get(key)?.state ?? "IDLE";
  }

  /** Get full coin context (for invalidation bridge setup ID matching). */
  getCoinContext(coin: string): Readonly<CoinContext> | null {
    const key = stateKey(coin);
    return this.coins.get(key) ?? null;
  }

  /** Get coins that are currently in position or entering. */
  getOpenPositionCoins(): string[] {
    const coins: string[] = [];
    for (const [, ctx] of this.coins) {
      if (ctx.state === "IN_POSITION" || ctx.state === "ENTERING") {
        if (!coins.includes(ctx.coin)) {
          coins.push(ctx.coin);
        }
      }
    }
    return coins;
  }

  /** Get the shared global runtime context. */
  getGlobal(): Readonly<GlobalContext> {
    return this.global;
  }

  /** Subscribe to agent actions (for orchestrator in S6/S7). */
  onAction(listener: (action: AgentAction) => void): void {
    this.emitter.on("action", listener);
  }

  /** Subscribe to trade close events (for metrics refresh). */
  onTradeClose(listener: (coin: string, pnl: number) => void): void {
    this.tradeCloseListeners.push(listener);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private getOrCreateCoinContext(key: string, coin: string): CoinContext {
    const existing = this.coins.get(key);
    if (existing) return existing;
    const ctx: CoinContext = {
      state: "IDLE",
      coin,
      activeSetup: null,
      pendingOrderId: null,
      positionId: null,
      stateEnteredAt: Date.now(),
      consecutiveLosses: 0,
      pauseReason: null,
      pauseUntil: null,
    };
    this.coins.set(key, ctx);
    return ctx;
  }

  /** Apply event-driven context mutations. Called once per dispatch, regardless of action count. */
  private applyEventContext(ctx: CoinContext, event: AgentEvent): void {
    if (event.type === "order_submitted") {
      ctx.pendingOrderId = event.orderId;
    }

    if (event.type === "order_filled") {
      ctx.pendingOrderId = null;
      ctx.positionId = event.positionId;
    }

    if (event.type === "order_rejected" || event.type === "order_timeout") {
      ctx.pendingOrderId = null;
      ctx.activeSetup = null;
    }

    if (event.type === "setup_invalidated") {
      if (ctx.state === "IDLE" || ctx.state === "WATCHING") {
        ctx.activeSetup = null;
      }
    }

    if (
      event.type === "position_closed" ||
      event.type === "sl_hit" ||
      event.type === "tp_hit" ||
      event.type === "trail_stop_hit"
    ) {
      // Guard on positionId: close paths can dispatch twice for one position
      // (e.g. thesis close: IN_POSITION→EXITING then EXITING→IDLE). Only the
      // first close event — while positionId is still set — records PnL and
      // loss streaks; the completion event must not double-count.
      if (ctx.positionId !== null) {
        const pnl = "pnl" in event ? event.pnl : 0;
        if (pnl < 0) {
          ctx.consecutiveLosses++;
        } else {
          ctx.consecutiveLosses = 0;
        }
        // Update global dailyPnl + circuit breakers
        this.recordPnl(pnl, undefined, ctx.coin);
      }
      ctx.positionId = null;
      ctx.activeSetup = null;
    }

    if (event.type === "pause" || event.type === "circuit_break") {
      ctx.pauseReason = event.reason;
      ctx.pauseUntil = event.type === "circuit_break" ? event.pauseUntil : null;
    }

    if (event.type === "resume") {
      ctx.pauseReason = null;
      ctx.pauseUntil = null;
      ctx.activeSetup = null;
    }
  }

  /** Apply action-driven context mutations. Called once per emitted action. */
  private applyActionContext(ctx: CoinContext, action: AgentAction): void {
    if (action.type === "watch" || action.type === "place_order") {
      ctx.activeSetup = action.setup;
    }
  }

  /**
   * Filter place_order actions through portfolio risk check (S6).
   * Returns original array if no place_order, or filtered array if blocked.
   */
  private filterByPortfolioRisk(
    actions: AgentAction[],
    coin: string,
    ctx: CoinContext,
  ): AgentAction[] {
    const hasPlaceOrder = actions.some((a) => a.type === "place_order");
    if (!hasPlaceOrder || this.accountEquity <= 0) return actions;

    // Build current portfolio positions from IN_POSITION/ENTERING coins.
    // Exclude the current coin — ctx.state was already set to ENTERING before this check,
    // so it would otherwise count against itself (off-by-one: effective max becomes max-1).
    const portfolioPositions = this.getPortfolioPositions().filter(
      (p) => p.coin !== coin,
    );

    // Estimate proposed notional from setup (use risk per trade × account as fallback)
    const _placeAction = actions.find((a) => a.type === "place_order");
    // Use a conservative estimate: account equity × risk per trade as proposed notional
    // Real notional will be computed by PositionSizer in S7, but we need an estimate here
    const proposedNotional = this.accountEquity * DEFAULT_RISK_PERCENT;

    const check = checkPortfolioEntry({
      positions: portfolioPositions,
      accountEquity: this.accountEquity,
      proposedNotional,
    });

    if (!check.allowed) {
      // Replace place_order with skip journal entry, keep other actions (dispatch logs SKIP line)
      return [
        ...actions.filter((a) => a.type !== "place_order"),
        journalAction("skip", coin, {
          reason: `portfolio risk: ${check.reason}`,
          setupId: ctx.activeSetup?.id,
        }),
      ];
    }

    return actions;
  }

  /**
   * Filter place_order actions through the advisor gate (learning loop v1).
   * Same veto contract as filterByPortfolioRisk: replace place_order with a
   * journal action (dispatch reverts state). Shadow mode journals the verdict
   * without altering actions; active mode enforces veto + size dampening.
   * Fail-open: mode off, no provider, or null/stale snapshot → pass-through.
   */
  private filterByAdvisor(actions: AgentAction[], coin: string): AgentAction[] {
    if (this.advisorMode === "off" || !this.advisorProvider) return actions;

    const placeAction = actions.find(
      (a): a is { type: "place_order"; setup: ActiveSetup } =>
        a.type === "place_order",
    );
    if (!placeAction) return actions;

    const snapshot = this.advisorProvider.getSnapshot();
    if (!isSnapshotFresh(snapshot, Date.now())) return actions;

    const setup = placeAction.setup;
    const dims: SetupDims = {
      pattern: setup.type,
      side: setup.side,
      regime: parseRegime(setup.patternData.regime),
      interval: setup.interval,
    };
    const verdict = evaluateSetup(dims, snapshot);
    const applied = this.advisorMode === "active" && verdict.action !== "allow";

    const advisorJournal = journalAction("advisor", coin, {
      setupId: setup.id,
      mode: this.advisorMode,
      applied,
      action: verdict.action,
      sizeMultiplier: verdict.sizeMultiplier,
      bucketKey: verdict.bucketKey,
      sampleSize: verdict.sampleSize,
      reason: verdict.reason,
    });

    if (applied && verdict.action === "veto") {
      log.info("agent", `${coin.padEnd(8)} ADVISOR VETO | ${verdict.reason}`);
      return [
        ...actions.filter((a) => a.type !== "place_order"),
        advisorJournal,
      ];
    }

    if (applied && verdict.action === "dampen") {
      log.info("agent", `${coin.padEnd(8)} ADVISOR DAMPEN | ${verdict.reason}`);
      // Shallow copy — never mutate the original setup (pipeline may reuse it).
      const dampened: AgentAction = {
        type: "place_order",
        setup: {
          ...setup,
          patternData: {
            ...setup.patternData,
            advisorSizeMultiplier: verdict.sizeMultiplier,
          },
        },
      };
      return [
        ...actions.map((a) => (a === placeAction ? dampened : a)),
        advisorJournal,
      ];
    }

    // allow verdict, or shadow mode — actions unchanged, verdict journaled.
    return [...actions, advisorJournal];
  }

  /** Build portfolio positions from current IN_POSITION/ENTERING coins. */
  private getPortfolioPositions(): PortfolioPosition[] {
    const positions: PortfolioPosition[] = [];
    for (const [, ctx] of this.coins) {
      if (ctx.state === "IN_POSITION" || ctx.state === "ENTERING") {
        // Estimate notional as accountEquity × DEFAULT_RISK_PERCENT per position
        // Real notional tracked by PositionMonitor in S7
        positions.push({
          coin: ctx.coin,
          notionalValue: this.accountEquity * DEFAULT_RISK_PERCENT,
        });
      }
    }
    return positions;
  }

  /** Get state by full key (internal). */
  private getCoinStateByKey(key: string): AgentState {
    return this.coins.get(key)?.state ?? "IDLE";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function journalAction(
  eventType: string,
  coin: string,
  details: Record<string, unknown>,
): AgentAction {
  return { type: "log_journal", eventType, coin, details };
}

/** Runtime guard for the MarketRegime union (patternData is untyped). */
const MARKET_REGIMES: ReadonlySet<string> = new Set([
  "BULL",
  "BEAR",
  "SIDEWAYS",
  "VOLATILE",
]);

/** Validate untyped patternData.regime against MarketRegime; invalid → null. */
function parseRegime(value: unknown): MarketRegime | null {
  return typeof value === "string" && MARKET_REGIMES.has(value)
    ? (value as MarketRegime)
    : null;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let agentInstance: TradingAgent | null = null;

/** Get or create the singleton agent. */
export function getAgent(): TradingAgent {
  if (!agentInstance) {
    agentInstance = new TradingAgent();
  }
  return agentInstance;
}

/** Reset agent (tests only). */
export function resetAgent(): void {
  agentInstance = null;
}
