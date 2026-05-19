import type { Candle, CandleInterval, Signal, StrategyContext } from '../types.js'
import type { StrategyParams } from '../backtest/types.js'
import { STATE_REPLAY_BARS } from '../config.js'
import { SmcSdStrategy } from './strategies/smc-sd/index.js'

// ── Window Requirements ────────────────────────────────────────────────────

/** Strategy-declared data depth + replay needs.
 *  Orchestrator + runtime use these to size scan windows and bootstrap replay. */
export interface WindowRequirements {
  /** Bars needed per TF for live scan (planning depth). */
  planningBars: Partial<Record<CandleInterval, number>>
  /** Bars per TF when serving as HTF context for another TF (separate from planningBars). */
  htfContextBars: Partial<Record<CandleInterval, number>>
  /** Bars per TF to replay at bootstrap for state rebuild. */
  replayBars: Partial<Record<CandleInterval, number>>
  /** TFs that must exist in store before replay starts (e.g., 1d for 4h HTF context). */
  preseedTFs: CandleInterval[]
}

// ── SetupGenerator interface ───────────────────────────────────────────────

export interface SetupGenerator {
  scan(
    coin: string,
    interval: CandleInterval,
    candles: Candle[],
    idx: number,
    context?: StrategyContext,
    strategyParams?: StrategyParams,
  ): Signal | null

  /** Declare data depth + replay needs. Orchestrator uses this to size windows. */
  windowRequirements?(): WindowRequirements

  clearState(): void
}

let setupGenerator: SetupGenerator = new SmcSdStrategy()

function legacyWindowRequirements(): WindowRequirements {
  return {
    planningBars: {},
    htfContextBars: {},
    replayBars: { ...STATE_REPLAY_BARS },
    preseedTFs: [],
  }
}

export function getSetupGenerator(): SetupGenerator {
  return setupGenerator
}

export function getSetupGeneratorWindowRequirements(): WindowRequirements {
  return typeof setupGenerator.windowRequirements === 'function'
    ? setupGenerator.windowRequirements()
    : legacyWindowRequirements()
}

export function runSetupGenerator(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  context?: StrategyContext,
  strategyParams?: StrategyParams,
): Signal | null {
  return setupGenerator.scan(coin, interval, candles, idx, context, strategyParams)
}

export function clearSetupGeneratorState(): void {
  setupGenerator.clearState()
}

export function resetSetupGenerator(): void {
  setupGenerator = new SmcSdStrategy()
}

export function setSetupGeneratorForTests(generator: SetupGenerator | null): void {
  setupGenerator = generator ?? new SmcSdStrategy()
}
