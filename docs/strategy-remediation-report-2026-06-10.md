# Strategy Remediation Report - 2026-06-10

Scope: remediation evidence run after adding optimizer `--mode=5m-only`.

## Commands

- `ACTIVE_EXCHANGE=HL LOG_LEVEL=ERROR bun run src/backtest/optimize.ts 20 BTC,ETH,SOL,AVAX,LINK,ARB,APT,BNB,DOT,ATOM --mode=5m-only`
- `ACTIVE_EXCHANGE=HL LOG_LEVEL=ERROR bun run scripts/backtest/run-drilldown-diag.ts BTC,ETH,SOL,AVAX,LINK,ARB,APT,BNB,DOT,ATOM`

Note: an earlier optimizer attempt without `ACTIVE_EXCHANGE` produced 20/20 trial errors. Rerun with `ACTIVE_EXCHANGE=HL` succeeded.

## 5m-only Optimizer

- Run ID: `e4e000d7-0948-4dac-a2e3-adcb56e1a226`
- Results file: `results/optimize-2026-06-09T20-31-15-495Z.json`
- Coins: BTC, ETH, SOL, AVAX, LINK, ARB, APT, BNB, DOT, ATOM
- Trials: 20
- Successful trials: 20/20
- OOS trades: 0 across all trials
- Best OOS PF: 0
- Holdout candidates: 0
- Robust holdout pass: 0

Decision gate: fail. The required `holdout PF >= 1.1` with `>= 40` trades was not reached.

## Drilldown Diagnostic

- 4H stage: 0 calls, 0 POIs registered
- 15m stage: 574,270 calls, 574,270 no-HTF-POI drops
- 5m stage: 174,220 calls, 174,220 no-confirmed-POI drops
- Walk-forward full run: 0 trades, PF 0
- Isolated 5m run: 0 trades, PF 0

Interpretation: the walk-forward drilldown path is not blocked by simulator slot contention in this run. It has no upstream POI/confirmation supply.

## Raw Backtests

Raw 5m, no walk-forward:

- Trades: 146
- PF: 0.887
- Win rate: 41.8%
- Max drawdown: 33.4%
- Net PnL: -$1,455.88
- Expectancy: -$9.97
- Confidence wins: avg 0.876, min 0.599, max 1.000, n=61
- Confidence losses: avg 0.889, min 0.581, max 1.000, n=85

Raw 1H, no walk-forward:

- Trades: 82
- PF: 0.413
- Win rate: 42.7%
- Max drawdown: 103.7%
- Net PnL: -$10,447.18
- Confidence wins: avg 0.903, min 0.634, max 1.000, n=35
- Confidence losses: avg 0.913, min 0.634, max 1.000, n=47
- Per-coin: SOL PF 0.811 / 19 trades, BTC PF 0.400 / 30 trades, ETH PF 0.329 / 33 trades

Interpretation: current confidence scoring is not discriminative; losses have slightly higher average confidence than wins in both raw 5m and raw 1H samples.

## Decision

- Do not promote 5m drilldown as a live candidate from this evidence.
- Do not promote current raw 1H same-TF logic as a live candidate from this evidence.
- A true AMD standalone 1H scan is not yet a separate code path in the current repo; raw 1H diagnostic is not a substitute for implementing that hypothesis.
- Next strategy work should either implement and test the dedicated AMD standalone 1H hypothesis, or explicitly move to confidence scoring redesign with this report as the failure evidence for the current paths.
