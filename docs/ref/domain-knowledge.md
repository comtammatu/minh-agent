# Minh (明) — Domain Knowledge Reference

> Domain Knowledge — philosophy, meaning, pros/cons of each trading school.
> For detect/validate/invalidate rules (pseudocode), see [`knowledge-spec.md`](../spec/knowledge-spec.md).

---

## 1. Technical Analysis

The largest group of trading schools, based on analyzing price charts and historical data to predict future market direction.

### 1.1 Price Action

- **Philosophy**: Price reflects everything. Read pure price behavior without indicators.
- **Core tools**: Candlestick patterns, chart patterns (Head & Shoulders, Double Top/Bottom, Wedge, Triangle), Support & Resistance, Trendlines.
- **Core concepts**:
  - Pin Bar, Engulfing, Inside Bar
  - Breakout & Retest
  - Higher High / Higher Low, Lower High / Lower Low
  - Key Level (significant price zones)
- **Notable figures**: Al Brooks, Bob Volman, Lance Beggs, Nial Fuller.
- **Pros**: Simple, fast market reaction, applicable across all timeframes and markets.
- **Cons**: Subjective, heavily depends on the chart reader's experience.
- **Best suited for**: All markets (Forex, Crypto, Stocks, Futures).

### 1.2 Smart Money Concepts (SMC) / ICT

- **Philosophy**: "Smart money" (banks, hedge funds, market makers) manipulates the market to capture liquidity from retail traders. Traders must learn to read smart money footprints.
- **Founder**: ICT — Inner Circle Trader (Michael Huddleston).
- **Core concepts**:
  - **Order Block (OB)**: Price zone where smart money placed large orders, typically the last candle before a strong move.
  - **Fair Value Gap (FVG)**: An imbalance zone between 3 consecutive candles that price tends to revisit and fill.
  - **Liquidity Sweep / Liquidity Grab**: Smart money pushes price past retail stop-losses to capture liquidity before reversing.
  - **Break of Structure (BOS)**: Confirms trend continuation when price breaks a previous high/low.
  - **Change of Character (CHoCH)**: Trend reversal signal when market structure changes.
  - **Premium / Discount Zone**: Divides range into high zone (premium — sell) and low zone (discount — buy) based on Fibonacci 50%.
  - **Inducement**: Small liquidity trap before price reaches the main Order Block.
  - **Optimal Trade Entry (OTE)**: Optimal entry zone, typically at Fibonacci 62%-79% of a swing.
- **Pros**: Tight logical framework, provides specific entry/exit points, explains many market "traps."
- **Cons**: Complex for beginners, prone to over-analysis, some concepts lack statistical validation.
- **Best suited for**: Forex, Crypto, Indices.

### 1.3 Volume Spread Analysis (VSA)

- **Philosophy**: The relationship between spread (candle range) and volume reveals "big boys'" intent — whether they're accumulating or distributing.
- **Foundation**: Richard Wyckoff → developed by Tom Williams.
- **Core concepts**:
  - **No Demand**: Small up candle + low volume → no real buying pressure.
  - **No Supply**: Small down candle + low volume → no real selling pressure.
  - **Stopping Volume**: Abnormally high volume at bottom → big players are buying.
  - **Climactic Action**: Extremely high volume + wide spread → potential top/bottom.
  - **Test**: Price revisits an old zone with low volume → confirms no remaining supply/demand.
  - **Upthrust / Spring**: Price trap at top/bottom before reversal.
- **Pros**: Reads the real intent behind price action.
- **Cons**: Requires accurate volume data (difficult with Forex spot), demands high experience.
- **Best suited for**: Stocks, Futures (where real volume exists).

### 1.4 Indicator-Based Trading

- **Philosophy**: Use mathematical formulas calculated on price/volume data to generate buy/sell signals.
- **Common indicators**:
  - **Trend**: Moving Averages (SMA, EMA), MACD, ADX, Ichimoku Cloud.
  - **Momentum**: RSI, Stochastic Oscillator, CCI, Williams %R.
  - **Volatility**: Bollinger Bands, ATR, Keltner Channel.
  - **Volume**: OBV, Volume Profile, VWAP, MFI.
- **Trading methods**:
  - Crossover (MA crossover, MACD signal line)
  - Overbought / Oversold (RSI > 70 / < 30)
  - Divergence (price vs indicator divergence)
  - Squeeze (Bollinger Band narrows → breakout imminent)
- **Pros**: Easy to learn, clear signals, easy to backtest and automate.
- **Cons**: Lagging (behind price), prone to whipsaw in sideways markets, creates false sense of certainty.
- **Best suited for**: Beginners, all markets.

### 1.5 Harmonic Patterns

- **Philosophy**: Markets move in repeating geometric patterns based on precise Fibonacci ratios.
- **Notable figure**: Scott Carney (systematized the approach).
- **Key patterns**:
  - **Gartley** (222 pattern): XA → AB (61.8%) → BC (38.2%-88.6%) → CD (78.6% XA).
  - **Bat**: CD completes at 88.6% XA.
  - **Butterfly**: CD extends beyond X, completing at 127% XA.
  - **Crab**: CD completes at 161.8% XA — pattern with farthest PRZ (Potential Reversal Zone).
  - **Cypher**: Special variant with unique Fibonacci ratios.
  - **Shark (5-0)**: Newer pattern with distinct structure.
- **Pros**: Very specific entry/exit points with tight stop-loss, typically good risk/reward.
- **Cons**: Patterns rarely form perfectly, requires patience, win rate not high when used alone.
- **Best suited for**: Forex, Stocks, combined with other methods.

### 1.6 Elliott Wave Theory

- **Philosophy**: Markets move in repeating wave cycles across all timeframes (fractal). Reflects crowd psychology.
- **Founder**: Ralph Nelson Elliott (1930s).
- **Core structure**:
  - **Impulse Wave (5 motive waves)**: Waves 1 → 2 → 3 → 4 → 5 in the main trend direction.
  - **Corrective Wave (3 corrective waves)**: Waves A → B → C against the main trend.
  - **Invariant rules**: Wave 2 cannot retrace below Wave 1 start; Wave 3 is never the shortest; Wave 4 cannot overlap Wave 1.
- **Fibonacci integration**: Wave 3 often = 161.8% of Wave 1; Wave 2 retraces 50%-61.8%; Wave 5 = Wave 1 or 61.8% of Wave 1.
- **Pros**: Provides big-picture view of current position in the larger cycle, identifies distant targets.
- **Cons**: Very subjective wave counting — 10 people produce 10 different counts, hard to apply in real-time.
- **Notable figures**: Robert Prechter, Glenn Neely.
- **Best suited for**: All markets, typically used for long-term analysis.

### 1.7 Wyckoff Method

- **Philosophy**: Markets are driven by the "Composite Man" (aggregate of large players). Traders must read the Composite Man's behavior through price and volume.
- **Founder**: Richard D. Wyckoff (early 20th century).
- **4 market phases**:
  - **Accumulation**: Large players quietly buy after a downtrend. Price moves sideways, volume gradually decreases.
  - **Markup**: Price begins uptrend after sufficient accumulation.
  - **Distribution**: Large players sell after an uptrend. Price moves sideways at top, abnormal volume.
  - **Markdown**: Price begins downtrend after distribution is complete.
- **Key Accumulation events**: PS (Preliminary Support) → SC (Selling Climax) → AR (Automatic Rally) → ST (Secondary Test) → Spring → SOS (Sign of Strength) → LPS (Last Point of Support).
- **3 Wyckoff laws**: Supply & Demand, Cause & Effect, Effort vs Result.
- **Pros**: Comprehensive framework, theoretical foundation for SMC and VSA.
- **Cons**: Requires significant time and experience to identify accurately.
- **Best suited for**: All markets, especially Stocks and Crypto.

### 1.8 Supply & Demand

- **Philosophy**: Price moves due to supply-demand imbalances. Identify strong supply/demand zones on chart to enter when price revisits.
- **Notable figure**: Sam Seiden (Online Trading Academy).
- **Core concepts**:
  - **Demand Zone**: Price area where buying force exceeds selling force, creating a strong upward move.
  - **Supply Zone**: Price area where selling force exceeds buying force, creating a strong downward move.
  - **Fresh Zone**: Untested zone — has the highest probability of reaction.
  - **Origin of Move**: The candle/cluster of candles before price moved strongly.
  - **Rally-Base-Drop (RBD)**: Supply zone formed when price rises → consolidates → drops sharply.
  - **Drop-Base-Rally (DBR)**: Demand zone formed when price drops → consolidates → rises sharply.
- **Difference from Support/Resistance**: S/R are lines, S/D are zones. S/D emphasizes "freshness" and formation mechanism.
- **Pros**: Simple logic, good risk/reward, clear entry points.
- **Cons**: Hard to distinguish strong/weak zones, not all zones hold.
- **Best suited for**: Forex, Crypto, Stocks.

### 1.9 Order Flow / Market Profile

- **Philosophy**: Read actual order flow — who is buying/selling, at what price, with what volume. See "behind the scenes" of each candle.
- **Core tools**:
  - **DOM (Depth of Market)**: Order book showing pending buy/sell orders at each price level.
  - **Footprint Chart**: Chart showing actual buy/sell volume at each price level within each candle.
  - **Market Profile (TPO)**: Time distribution at each price level → identifies Value Area, POC (Point of Control).
  - **Volume Profile**: Volume distribution by price level → finds HVN (High Volume Node) and LVN (Low Volume Node).
  - **Delta**: Difference between aggressive buy volume and aggressive sell volume.
  - **Cumulative Delta**: Accumulated delta over time → measures overall buy/sell pressure.
- **Popular software**: Bookmap, Sierra Chart, Jigsaw Trading, ATAS, Exocharts (Crypto).
- **Pros**: Most objective data, sees "reality" instead of "interpretation."
- **Cons**: Expensive (software + data feed), steep learning curve, only effective in markets with real volume (Futures, Crypto on-exchange).
- **Best suited for**: Futures (ES, NQ, CL), Crypto (order book exchanges).

---

## 2. Fundamental Analysis

Evaluates intrinsic value of assets based on economic, financial, and business data.

### 2.1 Value Investing

- **Philosophy**: Buy assets when market price is below intrinsic value. "Margin of Safety."
- **Notable figures**: Benjamin Graham ("The Intelligent Investor"), Warren Buffett, Charlie Munger, Seth Klarman.
- **Valuation methods**: P/E, P/B, P/S, EV/EBITDA, DCF (Discounted Cash Flow), DDM (Dividend Discount Model).
- **Stock selection criteria**: Stable earnings, low debt, high ROE, good management, competitive moat.
- **Pros**: Solid theoretical foundation, suited for long-term investing.
- **Cons**: Requires extensive analysis time, potential "value trap," ineffective short-term.
- **Best suited for**: Stocks, long-term investing.

### 2.2 Macro Trading / Global Macro

- **Philosophy**: Trade based on global macroeconomic trends — interest rates, inflation, GDP, monetary policy, geopolitics.
- **Notable figures**: George Soros, Ray Dalio, Paul Tudor Jones, Stanley Druckenmiller.
- **Key factors to monitor**:
  - Central bank policy (Fed, ECB, BOJ) — interest rates, QE/QT
  - CPI, PPI, PCE (inflation)
  - NFP, Unemployment Rate (labor market)
  - GDP, PMI (economic health)
  - Yield Curve, Bond Spread
  - Commodity prices (Oil, Gold)
  - Geopolitics, Trade wars
- **Pros**: Big-picture understanding, trades multiple asset classes.
- **Cons**: Complex, many variables, difficult timing.
- **Best suited for**: Forex, Bonds, Commodities, Indices.

### 2.3 Growth Investing

- **Philosophy**: Invest in companies with superior revenue/earnings growth, accepting high valuations (high P/E).
- **Notable figures**: Peter Lynch ("One Up on Wall Street"), Philip Fisher, Cathie Wood (ARK Invest), William O'Neil (CANSLIM).
- **Criteria**: Revenue growth > 20%/year, expanding market share, disruptive product/service, large TAM (Total Addressable Market).
- **CANSLIM (William O'Neil)**: Current earnings, Annual earnings, New products, Supply/demand, Leader/laggard, Institutional sponsorship, Market direction.
- **Pros**: Large profit potential when picking correctly.
- **Cons**: High risk when growth slows, prone to "overpaying."
- **Best suited for**: Stocks (especially Tech), medium to long-term investing.

---

## 3. Quantitative / Algorithmic

Uses mathematics, statistics, and programming to develop & execute trading strategies.

### 3.1 Algorithmic Trading (Algo Trading)

- **Philosophy**: Systematize strategies into code, eliminate emotions, backtest on historical data, and let bots execute automatically.
- **Workflow**: Idea → Code → Backtest → Optimize → Paper trade → Live trade → Monitor.
- **Common languages**: Python (Backtrader, Zipline, QuantConnect), Pine Script (TradingView), MQL4/5 (MetaTrader), C++ (HFT).
- **Common strategies**:
  - Trend Following (MA crossover, Breakout)
  - Mean Reversion (Bollinger Band bounce, RSI extremes)
  - Arbitrage (cross-exchange, triangular)
  - Market Making (spread capture)
  - Grid Trading
- **Pros**: Emotion-free, scalable, runs 24/7, backtestable.
- **Cons**: Overfitting in backtests, requires continuous maintenance, slippage & latency, regime change.
- **Best suited for**: All markets, especially Crypto (24/7) and Forex.

### 3.2 Statistical Arbitrage (Stat Arb)

- **Philosophy**: Exploit statistical deviations between correlated assets. When spread deviates from mean, bet on mean reversion.
- **Key strategies**:
  - **Pairs Trading**: Long underperforming asset + Short outperforming asset in a correlated pair (e.g., Coca-Cola vs Pepsi).
  - **Mean Reversion**: Price/spread will revert to mean.
  - **Cointegration-based**: Find cointegrated asset pairs (not just correlated).
  - **Factor Models**: Fama-French, momentum, value factors.
- **Mathematical tools**: Z-score, Augmented Dickey-Fuller test, Johansen test, Kalman Filter, PCA.
- **Pros**: Market-neutral (less dependent on market direction), solid mathematical foundation.
- **Cons**: Spread can diverge further, requires large capital, model risk.
- **Best suited for**: Stocks, ETFs, Futures.

### 3.3 High Frequency Trading (HFT)

- **Philosophy**: Ultra-high speed trading (microsecond to nanosecond) to exploit tiny inefficiencies.
- **Strategies**: Market Making, Latency Arbitrage, high-speed Statistical Arbitrage, News-based (NLP).
- **Infrastructure requirements**: Co-location (servers next to exchange), FPGA/ASIC hardware, direct market access, low-latency network.
- **Notable firms**: Citadel Securities, Virtu Financial, Jump Trading, Two Sigma.
- **Pros**: Stable returns (for those with infrastructure), provides market liquidity.
- **Cons**: Extremely high infrastructure costs, not for retail traders, heavily regulated.
- **Best suited for**: Institutional/prop firms only.

---

## 4. Sentiment-Based

Trading based on crowd psychology and money flow rather than just chart analysis or fundamentals.

### 4.1 Sentiment Analysis

- **Philosophy**: Measure and trade based on overall market sentiment.
- **Sentiment measurement tools**:
  - **Fear & Greed Index**: CNN (Stocks), Alternative.me (Crypto).
  - **COT Report (Commitments of Traders)**: Positions of Commercial, Non-commercial, Retail on Futures.
  - **Put/Call Ratio**: Options put/call ratio → measures pessimism level.
  - **VIX (Volatility Index)**: Market "fear index."
  - **Social Sentiment**: Twitter/X, Reddit, TikTok, Google Trends analysis.
  - **Funding Rate** (Crypto): Measures Long/Short position skew on Perpetual Futures.
  - **Open Interest**: Total open contracts → measures market interest level.
- **Pros**: Catches extreme points (extreme fear/greed), leads price action.
- **Cons**: Difficult to time precisely, sentiment can persist for extended periods.
- **Best suited for**: All markets, best used in combination.

### 4.2 Contrarian Trading

- **Philosophy**: Go against the crowd. When everyone is bullish → prepare for a reversal down. When everyone is bearish → buying opportunity.
- **Classic quote**: "Be fearful when others are greedy, and greedy when others are fearful." — Warren Buffett.
- **Entry signals**: Extreme sentiment, saturated media coverage, retail FOMO/panic, price-sentiment divergence.
- **Pros**: Catches potential tops/bottoms, good risk/reward.
- **Cons**: "The market can stay irrational longer than you can stay solvent." Timing is extremely difficult.
- **Best suited for**: All markets, especially Crypto (high volatility).

### 4.3 Momentum Trading

- **Philosophy**: "Trend is your friend." Rising assets tend to keep rising, falling assets tend to keep falling. Jump on the moving train.
- **Tools**:
  - Relative Strength (cross-asset performance comparison)
  - Rate of Change (ROC)
  - ADX (Average Directional Index)
  - Volume confirmation
  - 52-week high/low breakout
- **Strategy**: Buy outperforming assets, sell/short underperforming assets. Rotate by strong sector/industry.
- **Pros**: Follows trend — higher probability, no need to predict tops/bottoms.
- **Cons**: Gets whipsawed when trends end, large drawdown on reversals.
- **Best suited for**: Stocks (sector rotation), Crypto, Futures.

---

## 5. Popular Method Combinations

In practice, professional traders often combine multiple schools. Below are common combos:

| Combo | Description | Best for |
|---|---|---|
| SMC + Price Action | Use SMC for bias & zones of interest, PA for entry confirmation | Forex, Crypto |
| Wyckoff + VSA | Wyckoff framework for big picture, VSA to confirm accumulation/distribution | Stocks, Futures |
| Supply & Demand + Order Flow | S&D for zones of interest, Order Flow to confirm real volume | Futures, Crypto |
| Elliott Wave + Fibonacci + Price Action | EW for bias, Fib for targets, PA for entry | All markets |
| Macro + Technical | Fundamental for bias direction, Technical for entry timing | Forex, Indices |
| Momentum + Growth Investing | Pick growth stocks, time entry with momentum | Stocks |
| Algo + Statistical Arbitrage | Code stat arb strategy, run automatically | Stocks, Crypto |
| Sentiment + Contrarian + Technical | Sentiment extreme → Contrarian bias → Technical entry | Crypto, Stocks |

---

## 6. Classification by Timeframe

| Style | Timeframe | Common schools |
|---|---|---|
| **Scalping** | Tick → 5 min | Order Flow, Price Action, HFT |
| **Day Trading** | 5 min → 1 hour | SMC, Price Action, Indicator, Order Flow |
| **Swing Trading** | 1 hour → Daily | SMC, Elliott Wave, Supply & Demand, Harmonic |
| **Position Trading** | Daily → Weekly | Wyckoff, Macro, Value Investing, Growth |
| **Investing** | Monthly → Years | Value, Growth, Macro |

---

## 7. Learning Resources by School

| School | Core books / courses |
|---|---|
| Price Action | Al Brooks — "Trading Price Action" series; Nial Fuller blog |
| SMC / ICT | ICT YouTube Channel (free), ICT Mentorship |
| VSA | Tom Williams — "Master the Markets" |
| Wyckoff | Hank Pruden — "The Three Skills of Top Trading"; Wyckoff Analytics |
| Elliott Wave | Robert Prechter — "Elliott Wave Principle" |
| Harmonic | Scott Carney — "Harmonic Trading" Vol 1 & 2 |
| Order Flow | Jigsaw Trading education; Axia Futures |
| Value Investing | Benjamin Graham — "The Intelligent Investor"; Warren Buffett's Letters |
| Macro | Ray Dalio — "Principles for Navigating Big Debt Crises" |
| Algo Trading | Ernest Chan — "Quantitative Trading"; QuantConnect bootcamp |

---

## 8. Important Notes for the Agent

1. **No single school is "the best"** — each method has its own pros/cons and suits different trader personalities, capital, and time availability.
2. **Risk Management > Strategy** — Risk management (stop-loss, position sizing, risk/reward ratio) is more important than analysis method.
3. **Beware of bias**: When advising, avoid favoring one school. Always mention drawbacks.
4. **Backtest & Forward Test**: Any strategy must be validated before using real money.
5. **Trading psychology**: Discipline, patience, emotional control are the deciding factors of success, not the strategy itself.
6. **Markets change**: A strategy that works in trending markets may fail in ranging conditions and vice versa. Traders must know when to stay out.

---

## 9. How Technical Analysis Schools Complement Each Other

### 9.1 Core principle: Each school answers a different question

TA schools don't oppose or replace each other — they view the market from different angles and stack like filter layers. The more layers of confirmation that agree, the higher the trade's probability of success.

| Layer | School | Question answered | Role |
|---|---|---|---|
| 1 — Bias | Wyckoff / SMC | "What is smart money doing?" | Determine trade direction (Long or Short) |
| 2 — Structure | Price Action | "What is the current price structure?" | Confirm or deny bias |
| 3 — Zone | Supply & Demand / Harmonic | "Where to enter?" | Find specific entry point |
| 4 — Confirm | VSA / Order Flow | "Is there volume confirmation?" | Filter weak zones, confirm strong zones |
| 5 — Trigger | Indicator / Elliott Wave | "Timing & target?" | Trigger entry + take-profit target |
| 6 — Context | Sentiment / Macro | "What is the market context?" | Tailwind or headwind |

### 9.2 Layered decision process — BTC/USDT real example

**Layer 1 — Wyckoff / SMC: Determine Bias**

Look at Daily/4H chart to identify market phase:
- Wyckoff: Currently in Accumulation, Markup, Distribution, or Markdown?
- SMC: Has a Liquidity Sweep just occurred? Break of Structure (BOS) or Change of Character (CHoCH)?
- Conclusion: "Should I go Long or Short?" — if can't answer, DO NOT proceed.

**Layer 2 — Price Action: Confirm Structure**

After establishing bias, read current price structure:
- Is price making Higher High / Higher Low (uptrend) or Lower High / Lower Low (downtrend)?
- Is any pattern forming (wedge, channel, flag)?
- If Wyckoff says "accumulation" but PA still making consecutive Lower Lows → not time to enter.

**Layer 3 — Supply & Demand / Harmonic: Find Entry**

When bias and structure agree, find specific entry:
- Supply & Demand: Untested demand zone (if Long) or supply zone (if Short).
- Harmonic: PRZ (Potential Reversal Zone) at precise Fibonacci ratios.
- SMC: Nearest Order Block or Fair Value Gap (FVG).
- All answer: "at what price to place limit order?"

**Layer 4 — VSA / Order Flow: Confirm with Volume**

When price reaches zone, check volume:
- VSA: Is there Stopping Volume (high volume + narrow spread + mid-close = strong buyer)?
- Order Flow / Footprint: Sudden positive delta at zone? Absorption on DOM?
- If price touches zone but volume is silent → weak zone, should skip.

**Layer 5 — Indicator / Elliott Wave: Timing & Target**

Precise entry trigger:
- RSI divergence at demand zone, MACD cross, price closes above EMA 21.
- Elliott Wave: If in wave 3, target = 161.8% extension of wave 1.
- Fibonacci extension/projection for take-profit levels.

**Layer 6 — Sentiment / Macro: Context**

Overarching external layer:
- Negative funding rate (many are Short) while wanting to Long → going against crowd = good.
- Fear & Greed Index at Extreme Fear → buying opportunity.
- Fed dovish → bullish for risk assets.
- Doesn't give specific signals but provides "tailwind" or "headwind."

### 9.3 Shared DNA map across schools

Most TA schools share a common ancestor in Wyckoff and share significant "DNA":

**Wyckoff lineage:**
- Wyckoff (1930s) → VSA (Tom Williams) → Order Flow (modern)
- Wyckoff (1930s) → SMC / ICT (Michael Huddleston) → Supply & Demand
- Same philosophy, different terminology and tools.

**Equivalent terminology across schools:**

| Market phenomenon | Wyckoff | SMC / ICT | Price Action | VSA |
|---|---|---|---|---|
| Smart money buying | Accumulation | Order Block | Support zone | Stopping Volume |
| Smart money selling | Distribution | Supply zone | Resistance zone | Climactic Action |
| Bottom trap | Spring | Liquidity Sweep | False breakout | No Supply test |
| Top trap | Upthrust | Liquidity Grab | Bull trap | Upthrust on high volume |
| Reversal confirmation | Sign of Strength | Change of Character | Trend reversal | Effort vs Result |
| Key price zone | Trading Range | Order Block / FVG | S/R level | High Volume Node |

**Fibonacci — the common thread:**
- Elliott Wave: measures wave length and retracement.
- Harmonic: defines XABCD ratios.
- SMC: divides Premium/Discount zone (Fib 50%), finds OTE (Fib 62%-79%).
- Supply & Demand: measures pullback depth into zone.
- When 3+ methods using Fibonacci all point to the same price zone → extremely strong confluence.

### 9.4 Confluence Principle

Confluence is when multiple independent analysis methods point to the same price zone or the same trade direction. This is the foundation of combining schools.

**Confluence scoring system (suggestion for Agent):**

| Confluence factors | Rating | Action |
|---|---|---|
| 1-2 factors | Weak setup (C-grade) | Skip or very small size (0.5% risk) |
| 3-4 factors | Average setup (B-grade) | Enter with standard size (1% risk) |
| 5-6 factors | Strong setup (A-grade) | Enter with larger size (1.5-2% risk) |
| 7+ factors | Excellent setup (A+ grade) | Maximum conviction, can scale in |

**A+ setup example on BTC:**
1. Wyckoff: Phase C — Spring just occurred (bottom Liquidity Sweep).
2. Price Action: Bullish Engulfing at Spring zone.
3. Supply & Demand: At untested demand zone (Drop-Base-Rally).
4. VSA: Stopping Volume appeared (high volume + narrow spread + mid-close).
5. RSI: Positive divergence at oversold zone.
6. Fibonacci: Price retraced exactly to 78.6% — coincides with SMC OTE zone.
7. Funding rate: Strongly negative (crowd is Short) → contrarian bullish.

### 9.5 Most Effective Combinations (Detailed)

**Combo 1: SMC + Price Action + Order Flow (Most popular for Crypto/Forex)**
- SMC: Determine bias via market structure (BOS/CHoCH), find Order Block & FVG.
- Price Action: Wait for confirmation candle (engulfing, pin bar) at OB/FVG.
- Order Flow: Confirm real volume entering the zone (delta, absorption).
- Advantage: Tight framework, applicable across all timeframes.
- Suggested timeframe: HTF bias (4H/Daily) → LTF entry (15m/5m).

**Combo 2: Wyckoff + VSA + Supply & Demand (Classic, for Stocks/Futures)**
- Wyckoff: Identify phase (Accumulation/Distribution) on Weekly/Daily.
- VSA: Confirm volume behavior at Wyckoff events (SC, Spring, SOS).
- S&D: Identify specific entry zone within the range.
- Advantage: Strongest theoretical foundation, tight logic.
- Suggested timeframe: Weekly bias → Daily zone → 4H entry.

**Combo 3: Elliott Wave + Fibonacci + Harmonic (For swing/position trading)**
- Elliott: Identify position in the larger wave cycle → know which wave you're in.
- Fibonacci: Find targets based on extension/projection.
- Harmonic: Find PRZ for precise entry.
- Advantage: Very distant and specific targets, typically high R:R ratio.
- Disadvantage: Subjective wave counting, requires patience.

**Combo 4: Indicator + Price Action + Sentiment (For beginners)**
- Indicator: EMA/RSI/MACD for basic signals.
- Price Action: Confirmation candle at indicator-identified zones.
- Sentiment: Fear & Greed, Funding rate for context.
- Advantage: Easy to learn, clear signals, less subjective.
- Disadvantage: Indicators lag, misses many opportunities.

### 9.6 Notes on combining schools

1. **Don't use too many methods simultaneously**: 2-3 primary methods + 1-2 supporting is enough. Too many leads to "analysis paralysis" — analyzing endlessly without entering a trade.
2. **Distinguish "confirmation" from "redundancy"**: RSI + Stochastic + CCI are all momentum oscillators → that's redundancy, not confirmation. Real confirmation comes from DIFFERENT perspectives (price + volume + sentiment).
3. **Higher timeframe always takes priority**: When HTF and LTF conflict, trust HTF. Daily bias > 1H bias > 5m bias.
4. **Not always necessary to have full confluence**: In strong trending markets, 2-3 factors suffice. In ranging/choppy markets, need 5+ factors.
5. **Every trader should have a "core method" + "supporting methods"**: Choose 1 school as foundation (e.g., SMC), then add 1-2 supporting methods (e.g., Order Flow + Sentiment). Don't try to master everything.

---

## 10. Algorithmic Trading — Extended Detail

### 10.1 Definition

Algorithmic Trading (Algo Trading) uses computer programs to automatically execute trades based on predefined rules. Eliminates emotion, increases reaction speed, and enables 24/7 operation.

### 10.2 Algo Trading Development Pipeline

```
Research → Code Strategy → Backtest → Evaluate Metrics → Optimize (avoid overfitting)
    ↑                                                           |
    |← Fail: return to Research ←←←←←←←←←←←←←←←←←←←←←←←←←←←←←|
                                                                |
    Pass ↓
Walk-Forward Test (Out-of-Sample) → Paper Trade → Live Trading → Monitor & Maintain
                                                                        |
    ↑←←←←←←←←←←←← Continuous improvement ←←←←←←←←←←←←←←←←←←←←←←←←←←←|
```

### 10.3 Algo Strategy Types (by complexity)

**Basic:**
- **Trend Following**: MA crossover, Donchian/Keltner channel breakout. Effective in trending markets, whipsawed in sideways.
- **Mean Reversion**: RSI extreme, Bollinger Band bounce, z-score reversion. Effective in ranging markets, fails in strong trends.

**Intermediate:**
- **Grid Trading**: Evenly spaced buy/sell order grid, automatic DCA. Risk: prolonged one-directional trend.
- **Momentum / Breakout**: Volume spike detection, range breakout, relative strength ranking.
- **Arbitrage**: Cross-exchange (price differences between exchanges), triangular (3 currency pairs), funding rate arb.
- **Pairs / Stat Arb**: Long/Short cointegrated asset pairs when spread deviates. Requires statistical knowledge.

**Advanced:**
- **Market Making**: Place simultaneous bid/ask, profit from spread. Risk: inventory when price moves one direction.
- **Sentiment / NLP**: Analyze news, social media, on-chain data with NLP to generate signals.
- **Machine Learning**: LSTM (time series), Random Forest (feature engineering), Reinforcement Learning (dynamic decision). Most powerful but most prone to overfitting.
- **Multi-Strategy Portfolio**: Ensemble multiple strategies, regime detection to switch. Most complex but most stable.
- **MEV / On-chain**: Sandwich attack, frontrunning, flash loan arbitrage. DeFi/blockchain specific.
- **HFT**: Latency arbitrage, co-location. Institutional only with specialized hardware infrastructure.

### 10.4 Algo Trading System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Algo Trading System                    │
│                                                          │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │  Data Layer   │→│Strategy Engine │→│ Risk Manager  │ │
│  │ REST/WebSocket│  │Signal generate│  │Position sizing│ │
│  │ OHLCV, OB    │  │Entry/Exit rule│  │Stop-loss, DD │ │
│  └──────────────┘  └───────────────┘  └──────┬───────┘ │
│                                               │         │
│  ┌──────────────────────┐  ┌──────────────────▼───────┐ │
│  │ Monitoring & Logging  │←│   Execution Engine       │ │
│  │ PnL, alerts, dashboard│  │Order routing, slippage   │ │
│  └──────────┬───────────┘  └──────────────────┬───────┘ │
│             │                                  │         │
│  ┌──────────▼───────────┐  ┌──────────────────▼───────┐ │
│  │      Database         │  │     Exchange API         │ │
│  │ Trades, candles, state│  │ Hyperliquid, Binance...  │ │
│  └──────────────────────┘  └─────────────────────────┘ │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │  Backtester (offline): same strategy engine + history ││
│  └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Module explanations:**
- **Data Layer**: Collects real-time data via REST (OHLCV, account) + WebSocket (orderbook, trades stream). Normalizes and stores to DB.
- **Strategy Engine**: The brain — receives data → computes signals → decides entry/exit. Must be written to run both live and backtest (same code, different data source).
- **Risk Manager**: Final filter before order submission. Checks position size, max allocation, drawdown threshold, correlation exposure.
- **Execution Engine**: Sends orders, selects order type (market/limit), handles slippage, retry logic, nonce management.
- **Monitoring**: PnL tracking, alert system, performance dashboard.
- **Backtester**: Same strategy engine but runs on historical data.

### 10.5 Key Evaluation Metrics

| Metric | Formula / Meaning | Target |
|---|---|---|
| **Sharpe Ratio** | (Return - Risk-free) / Std Dev. Return per unit of risk. | > 1.5 (good), > 2.0 (very good), > 3.0 (excellent, suspect overfitting) |
| **Max Drawdown** | Largest peak-to-trough capital decline. Most important psychological metric. | < 20% |
| **Win Rate** | % winning trades. Must be viewed alongside Risk:Reward ratio. | Depends on R:R (40% win + 1:3 R:R is still profitable) |
| **Profit Factor** | Gross Profit / Gross Loss. | > 1.5 |
| **Sortino Ratio** | Like Sharpe but only counts downside deviation. | > 2.0 |
| **Expectancy** | (Win% × Avg Win) - (Loss% × Avg Loss). Average $/trade. | Must be positive |
| **Calmar Ratio** | Annualized Return / Max Drawdown. | > 1.0 |
| **Recovery Factor** | Net Profit / Max Drawdown. Recovery capability. | > 3.0 |

### 10.6 Fatal Traps in Algo Trading

1. **Overfitting**: Bot performs beautifully in backtest, loses immediately when live. Cause: over-optimizing parameters on the same dataset. Solution: Walk-Forward Analysis, split in-sample/out-of-sample, minimize parameter count, test across multiple markets/timeframes.

2. **Survivorship Bias**: Backtesting on current coin/stock list (those that "survived"), forgetting delisted/dead assets. Backtest results are overly optimistic.

3. **Look-ahead Bias**: Accidentally using future data in backtest. E.g., using current candle's close price to decide entry at candle open.

4. **Slippage & Fees**: Backtesting with ideal fill prices, ignoring slippage and fees. Maker/taker fees + funding rate significantly erode PnL in high-frequency strategies.

5. **Regime Change**: Market character changes. Trending strategy works in bull but gets "chopped up" in ranging. Solution: regime detection (ADX, volatility filter) or multi-strategy portfolio.

6. **Data Quality**: Incorrect historical data (missing candles, wrong OHLCV) leads to wrong backtest results. Always validate data before backtesting.

7. **Curve Fitting**: Adding filters/conditions until backtest looks "beautiful" — but each added filter is another assumption that could be wrong in the future.

### 10.7 Suggested Tech Stack

**Languages:**
- Python: Backtest, research, ML (Backtrader, VectorBT, QuantConnect).
- TypeScript/JavaScript: Execution bot, real-time processing.
- Pine Script: Quick prototyping on TradingView.
- C++/Rust: HFT (not needed for retail).

**Backtest frameworks:**
- VectorBT: Fastest (vectorized), great for research.
- Backtrader: Most flexible, event-driven, closest to live trading.
- QuantConnect: Cloud-based, multi-asset, built-in data.
- Freqtrade: Open-source, built-in integration for many crypto exchanges.

**Data:**
- PostgreSQL / TimescaleDB: OHLCV time-series.
- Redis: Real-time data cache, order state.
- InfluxDB: Metrics & monitoring.

**Execution:**
- CCXT: Python/JS library supporting 100+ crypto exchanges.
- Specialized SDKs: `@nktkas/hyperliquid` (Hyperliquid), `python-binance`.

**Monitoring:**
- Grafana + Prometheus: Metrics dashboard.
- Custom dashboard: Integrate into existing system.

---

## 11. Conflict Situations Between Schools — Resolution Strategies

When combining multiple schools, signal conflicts are inevitable. Below are the 6 most common situations and resolution strategies for Agent reference.

### 11.1 RSI Oversold but Trend Still Falling Strongly

**Conflict**: Indicator (RSI < 30 = oversold, "should buy") vs Price Action / Trend Following (consecutive Lower Lows, EMA sloping down, "trend is still bearish").

**Root cause**: RSI oversold in a strong downtrend is the most common "false signal." RSI can remain below 30 for weeks in a trending market.

**Resolution**: Listen to Price Action. Only act when there is RSI **divergence** (price makes Lower Low but RSI makes Higher Low) AND Price Action shows a reversal candle (engulfing, pin bar). No divergence = no trade.

**Trap**: New traders buy immediately when RSI hits 30, getting "chopped" repeatedly. RSI only measures momentum, it's not a reversal signal.

**Agent rule**: When RSI oversold + downtrend → advise "wait for divergence + PA confirmation", do not advise "buy because oversold."

### 11.2 Price Touches Demand Zone but Price Action Shows No Rejection

**Conflict**: Supply & Demand (beautiful, fresh demand zone, "should buy") vs Price Action (consecutive red candles, wide spread, close near zone bottom, "no rejection").

**Root cause**: Not every demand zone holds. Statistically, only about 50-60% of fresh zones have a sufficiently strong reaction.

**Resolution**: Two approaches:
- **Aggressive**: Place limit order at zone, stop below zone, accept higher risk.
- **Conservative** (recommended): Wait for PA confirmation (pin bar, engulfing) at zone before entering. If price closes below zone with wide spread + high volume → zone is broken, cancel the scenario.

**Trap**: Placing "blind" limit orders at every demand zone without waiting for confirmation.

**Agent rule**: Always advise checking PA confirmation at zone before entering. A zone is only an "area of interest," not a "guaranteed bounce point."

### 11.3 Elliott Wave Counts Wave 5 (Reversal Coming) but SMC Still Shows Bullish BOS

**Conflict**: Elliott Wave (wave 5 nearing completion, "prepare to Short") vs SMC (consecutive Higher Highs, bullish BOS, no CHoCH yet, "still bullish").

**Root cause**: Elliott Wave predicts ahead (leading), SMC confirms after (lagging but more reliable). Wave 5 can extend very far (161.8%, even 261.8%).

**Resolution**: Listen to SMC for action, use Elliott for awareness:
1. Don't Short until bearish CHoCH appears on SMC.
2. Reduce new Long size when EW says near end of wave 5.
3. Tighten trailing stop on existing Long positions.
4. When bearish CHoCH appears → EW and SMC agree: that's the start of wave A correction → Short.

**Formula**: EW = "prepare", SMC CHoCH = "act."

**Trap**: Shorting to "call the top" because EW says wave 5 is almost done. 10 people counting waves, 10 different counts.

**Agent rule**: Never advise Shorting based solely on wave count. Always require CHoCH or structure signal first.

### 11.4 Price Breaks Out but Volume Doesn't Increase (VSA Bearish Divergence)

**Conflict**: Price Action (clean breakout, strong close above resistance) vs VSA / Order Flow (volume declining or flat, delta unimpressive).

**Root cause**: Effort vs Result law (Wyckoff): Price breaks up (Result) but volume doesn't increase (insufficient Effort) → imbalance → breakout may not be sustainable. Could be an Upthrust / Bull Trap.

**Resolution**: Listen to VSA/Order Flow — volume is "truth," price can be "manipulated." Three scenarios after a no-volume breakout:
1. **Upthrust / Bull trap**: Price will return to range, possibly drop sharply. Don't buy.
2. **Low-volume breakout success**: Rare but possible. Wait for retest + volume increase.
3. **Volume arrives late**: Sometimes a real breakout but volume lags 1-2 candles.

**Safe approach**: Wait for the next candle. If next candle after breakout has increasing volume + strong close → real breakout. If next candle is weak / doji / volume declining → likely fake breakout.

**Trap**: FOMO buying immediately on breakout without checking volume. This is the most common cause of "buy high, sell low."

**Agent rule**: Always check volume when analyzing breakouts. Breakout + low volume = red flag.

### 11.5 HTF Bullish (Daily Uptrend) but LTF Bearish (1H Bearish CHoCH)

**Conflict**: Daily chart (uptrend, Higher High / Higher Low, price above EMA 200) vs 1H chart (bearish CHoCH, bearish Break of Structure, new supply zone).

**Root cause**: Two timeframes see two different phases. LTF bearish within HTF bullish is usually just a pullback/correction.

**Resolution**: Depends on trading style:
- **Swing trader**: Listen to Daily. CHoCH on 1H is just a pullback. Wait for price to reach Daily demand zone → find new bullish CHoCH on 1H → Long.
- **Day trader**: Can Short following LTF, but: short target (only to nearest HTF demand zone), smaller size (counter-trend), tight stop.
- **Uncertain**: Stay out. When HTF and LTF conflict and can't be resolved → market is unclear.

**Golden rule**: HTF bias > LTF bias. Daily bearish + 1H bullish → only Long with small size, short target. Daily bullish + 1H bearish → 1H is just pulling back.

**Trap**: Shorting counter-trend with full size because "LTF has gone bearish." Bearish CHoCH on 1H in a Daily uptrend is often quickly invalidated when price hits Daily demand zone.

**Agent rule**: Always ask which timeframe the trader uses before advising. Counter-trend trades must always be smaller size with early profit-taking.

### 11.6 Extreme Fear Sentiment but Chart Still in Downtrend

**Conflict**: Sentiment / Contrarian (Fear & Greed < 15 = Extreme Fear, deeply negative funding rate, "should buy") vs Technical Analysis (Lower Low, bearish BOS, no Spring/CHoCH, "chart is still bearish").

**Root cause**: Sentiment indicates "market is near bottom" (zone), TA provides precise timing (point). Extreme Fear can persist for months (e.g., Crypto winter 2022 — Fear index < 20 for 6 months).

**Resolution**: Distinguish "invest" vs "trade":
- **If INVESTING** (long-term, spot, no leverage): Sentiment is correct. Extreme Fear is historically the best DCA zone. No need for perfect timing, buy gradually with fixed capital %.
- **If TRADING** (short-term, leverage, futures): Listen to TA. Don't Long with leverage when chart is bearish, even with extreme sentiment. Wait for Wyckoff Spring + SMC CHoCH + PA confirmation → then Long.

**Formula**: Sentiment = "prepare ammunition" (allocate capital, build watchlist). TA = "pull the trigger" (specific entry timing).

**Trap**: "Catching a falling knife" with leverage because "Fear & Greed says too scared." Sentiment provides zones, not points.

**Agent rule**: Always ask if the trader is "investing" or "trading" before advising on sentiment. If trading with leverage → require mandatory TA confirmation.

### 11.7 General Priority Rules for Conflicts

Below are rules for the Agent to handle conflicting signals between schools:

**Signal priority order:**

| Priority | Signal type | Role | Example |
|---|---|---|---|
| 1 (Highest) | Market Structure | Objective fact | BOS, CHoCH, Higher High/Lower Low |
| 2 | Volume / Order Flow | Confirms intent | VSA, Delta, Footprint |
| 3 | Price Action | Confirmation at zone | Pin bar, Engulfing, Inside Bar |
| 4 | Indicator | Supplementary timing | RSI, MACD, EMA |
| 5 | Elliott Wave / Harmonic | Predicts targets | Wave count, PRZ |
| 6 (Lowest) | Sentiment | Broad context | Fear & Greed, Funding rate |

**5 conflict resolution rules:**

1. **Structure > Indicator > Sentiment**: Price Action and Market Structure (BOS, CHoCH) are always "king." Indicators are supplementary tools. Sentiment provides context, not triggers.

2. **Higher timeframe beats lower timeframe**: Daily bias > 4H bias > 1H bias > 15m bias. When HTF and LTF conflict, trust HTF.

3. **Volume confirms price, not the other way around**: Breakout without volume → suspect. Volume increases but price doesn't move → preparing for explosive move. "Price is what happened, volume is why it happened."

4. **When conflict can't be resolved → reduce size or stay out**: Not required to trade at all times. When 2+ frameworks conflict → signal is "market is unclear." Reduce size 50% or skip.

5. **Distinguish "prediction" (leading) vs "confirmation" (lagging)**: Elliott Wave, Sentiment, Harmonic → predict ahead. SMC CHoCH, PA confirmation, VSA → confirm after. Use leading to "prepare," use lagging to "act."

---

## 12. Risk Management & Stop Loss — When Zone Is Far from Current Price

### 12.1 Foundational Principle

Stop loss has NO fixed number (not "always set 2%"). Stop must be placed where, if price reaches it → the trader's scenario is WRONG. The right question isn't "what % for stop" but "where does the trade become invalid, and what position size keeps dollar risk acceptable."

**Golden formula (invariant):**

```
Position Size = (Account × Risk%) / Stop Distance%

Example: Account $10,000, Risk 1% = $100 max loss
  Zone 2% away  → Size = $100/2% = $5,000 (0.50x leverage)
  Zone 5% away  → Size = $100/5% = $2,000 (0.20x leverage)
  Zone 10% away → Size = $100/10% = $1,000 (0.10x leverage)
```

When zone is far → wider stop → position size AUTOMATICALLY reduces to keep dollar risk constant. Never move stop closer to "fit the size" — that's the fastest way to blow an account.

### 12.2 Four Stop Methods When Zone Is Far

#### Method 1: Structure-based stop (Default — use for most trades)

Stop placed at scenario invalidation point per each school:

| School | Stop placement | Invalidation logic |
|---|---|---|
| SMC — Order Block | Below OB bottom + buffer | Price breaks through OB → OB failed → scenario wrong |
| Supply & Demand | Below demand zone bottom + 0.5-1 ATR buffer | Zone broken → supply-demand imbalance no longer exists |
| Wyckoff — Spring | Below Spring bottom | Price breaks below Spring → that wasn't a real Spring |
| Harmonic — PRZ | Below PRZ bottom | Extension beyond PRZ → pattern failed |

**Buffer is critical**: Add 0.5-1 ATR below zone/structure level. Market makers often sweep a few ticks below the zone before bouncing (wick hunt / stop hunt). Buffer helps avoid being swept by fake wicks.

**When zone is far, position size auto-reduces** — this is the self-protection mechanism. Small size + right direction is still profitable. Never increase risk % to maintain large size when zone is far.

#### Method 2: ATR-based stop (When no clear zone exists)

ATR (Average True Range) measures average candle range over N periods. ATR-based stop automatically expands/contracts with volatility — calm market means tighter stop, volatile market means wider stop.

**Formula:**

```
Stop = Entry - (ATR(14) × Multiplier)

Common multipliers:
  1.0x ATR → Tight (scalping, day trade)
  1.5x ATR → Standard (swing trade) — RECOMMENDED DEFAULT
  2.0x ATR → Wide (position trade)
  2.5-3.0x ATR → Very wide (volatile crypto, weekly chart)
```

**BTC example on Hyperliquid:**
```
BTC price $65,000. ATR(14) on 4H = $1,200. Swing trade using 1.5x ATR:
  Stop = $65,000 - ($1,200 × 1.5) = $63,200
  Stop distance = $1,800 = 2.77%
  Risk $100 → Size = $100/$1,800 = 0.0556 BTC = $3,611
```

**Combining ATR + Structure (best approach):** Place stop at structure level + add ATR buffer. E.g., demand zone bottom at $63,500, ATR buffer = $400 → Stop = $63,100. Has both invalidation logic and wick-hunt buffer.

**When to use pure ATR:** No clear demand zone nearby. Breakout/momentum trade (not zone-based). Scalping on LTF (1m-5m) where zones aren't meaningful.

#### Method 3: Partial entry / Scale-in (When zone is far but setup is too good to skip)

Instead of one full-size entry with wide stop, split into 2-3 entries:

```
Total trade risk: 1% ($100)

Entry 1 (40% risk = $40):
  Enter at current price
  Stop = ATR-based (tighter)
  Purpose: test direction, "pilot position"

Entry 2 (60% risk = $60):
  Enter when price pulls back closer to zone
  Stop = structure-based (below zone)
  Purpose: better entry price, tighter stop
```

**Logic:**
- If Entry 1 hits stop → Entry 2 may not need to be placed (bias invalidated). Total loss is only $40 instead of $100.
- If Entry 1 profits → trail stop on Entry 1 + enter Entry 2 at pullback → better average entry, larger total size.

**When to use partial entry:**
- Zone is 4-8% away but setup has strong confluence (5+ factors).
- In a trending market (pullback likely).
- Confident in bias but want better entry price.

#### Method 4: Skip trade + Alert (When R:R isn't worthwhile)

Knowing when NOT to enter is the hardest skill in trading.

**Skip when ANY of these conditions are met:**
- R:R < 1.5 — Stop is wider than potential profit.
- Stop > 3x ATR — Too wide relative to normal range.
- Position size < 0.1x account — Size too small, profit is negligible.
- Zone distance > 10% — Size too small to be meaningful for most account sizes.

**Instead of skipping entirely — set an alert:** Alert at 60-70% of the distance to zone. When price pulls back → zone is closer → tighter stop → larger size → better R:R. Be patient and let price come to you, don't chase price.

### 12.3 Quick Reference Table by Zone Distance

| Zone distance | Assessment | Action | Stop method | Min R:R |
|---|---|---|---|---|
| < 2% | Ideal | Full size, enter immediately | Structure + 0.5 ATR buffer | >= 1.5 |
| 2-3% | Good | Standard size (formula auto-reduces) | Structure + 0.5 ATR buffer | >= 1.5 |
| 3-5% | Somewhat far | Reduce size or partial entry | Structure or ATR 1.5x | >= 2.0 |
| 5-8% | Far | Partial entry or wait for pullback | ATR 2.0x or wait for price near zone | >= 2.5 |
| 8-10% | Very far | A+ setup only (7+ confluence). Or skip | ATR 2.5x, very small size | >= 3.0 |
| > 10% | Too far | Skip. Set alert and wait for pullback | Do not enter | N/A |

### 12.4 Three Survival Principles

**1. Never move stop closer to "fit the size"**

Stop must be placed at scenario invalidation point — not where "the account can handle." If the correct stop should be at $63,000 but you move it to $64,200 to "fit the size" → you'll get stopped at $64,200, then watch price bounce from $63,100 (the correct zone). The only solution: reduce size, NEVER move stop.

**2. Minimum R:R must be proportional to stop distance**

- Near zone (stop 1-2%) → R:R >= 1.5 is sufficient.
- Far zone (stop 3-5%) → R:R >= 2.0 mandatory.
- Very far zone (stop 5%+) → R:R >= 3.0.

Logic: wider stop = lower probability of hitting stop, but when wrong the loss is larger → needs bigger reward to compensate.

**3. Set alert instead of placing order when zone is > 5% away**

Instead of entering immediately with small size → set price alert at 60-70% of the distance. When price pulls back → zone is closer → tighter stop → larger size → better trade quality. Patience is the retail trader's biggest edge.

### 12.5 Stop Loss on Hyperliquid — Technical Notes for Agent

When implementing on Hyperliquid (or any perpetual futures exchange), the Agent must additionally check:

1. **Minimum order size**: Each asset has `szDecimals` and minimum notional. When stop is wide → calculated position size may be below minimum → trade is not feasible. Agent must check before placing orders.

2. **Funding rate impact**: With wide stops, trades may last several days. Accumulated funding rate (every 8h) erodes PnL. If funding rate is -0.05% per 8h and holding 3 days → additional ~0.45% loss from funding alone.

3. **Liquidation price vs Stop price**: Ensure stop price is ALWAYS triggered before liquidation price. With high leverage + wide stop, liquidation can be closer than stop → liquidated before stop is filled.

4. **Slippage on stop market orders**: Stop market orders on Hyperliquid can experience slippage, especially during high volatility or low liquidity. Agent should add 0.1-0.3% slippage buffer when calculating risk.

5. **Trailing stop**: Once trade is in profit, should trail stop (move to break-even, then follow new structure) instead of keeping stop fixed. Hyperliquid supports trailing stop via API.

### 12.6 Consolidated Calculation Formula for Agent

```
INPUT:
  account_balance    = total capital ($)
  risk_percent       = % risk per trade (recommended 0.5-2%)
  entry_price        = entry price
  zone_bottom        = zone bottom / structure level
  atr_value          = ATR(14) on trading timeframe
  tp_price           = take-profit price (from Fibonacci extension, structure target)

CALCULATE:
  risk_amount        = account_balance × risk_percent / 100
  atr_buffer         = atr_value × 0.5
  stop_price         = zone_bottom - atr_buffer
  stop_distance_abs  = entry_price - stop_price
  stop_distance_pct  = stop_distance_abs / entry_price × 100
  position_size_usd  = risk_amount / stop_distance_pct × 100
  position_size_coin = position_size_usd / entry_price
  leverage           = position_size_usd / account_balance
  tp_distance_pct    = (tp_price - entry_price) / entry_price × 100
  rr_ratio           = tp_distance_pct / stop_distance_pct

VALIDATE:
  IF stop_distance_pct > 10%    → SKIP trade, set alert
  IF rr_ratio < 1.5             → SKIP trade or find farther TP
  IF leverage > 5x              → WARNING high leverage
  IF position_size_coin < min_size → SKIP trade (below minimum order)
  IF stop_price > liquidation   → WARNING must reduce leverage

OUTPUT:
  stop_price, position_size_usd, position_size_coin, leverage, rr_ratio
  + verdict (GOOD / WARN / SKIP) with reason
```

---

*Last updated: March 2026*
*Internal reference document — Domain Knowledge for Trading Agent*
