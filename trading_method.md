# TAPIoca Trading Method

> PAPER strategy specification for external review  
> Last updated: 2026-07-23

## 1. Purpose

TAPIoca is an experimental asset-allocation agent for US ETFs. It combines
macroeconomic, news-sentiment, and sampled price-trend signals to choose a target
allocation, then simulates purchases and exits in a file-based PAPER wallet.

The current objective is to validate:

- Safety constraints
- Decision traceability
- State persistence
- Automated operation
- Telegram report usefulness
- Strategy behavior under different market regimes

The current objective is **not** to prove profitability or execute live orders.

## 2. Non-Goals

The current strategy is not:

- A high-frequency trading system
- A market-making strategy
- A same-asset simultaneous buy/sell strategy
- A statistical-arbitrage system
- An options or leveraged-products strategy
- A live brokerage execution engine

It does not intentionally place a buy and sell order for the same ETF at the
same time. Exits are evaluated before new purchases, and a sold symbol enters a
re-entry cooldown.

## 3. PAPER Capital and Universe

### Initial capital

```text
KRW 100,000 hard cap
```

The initial KRW amount is converted to USD once, using the Toss exchange-rate
response. The conversion rounds down to cents so the actual KRW-funded amount
cannot exceed KRW 100,000.

The observed initial PAPER wallet was:

```text
USD 67.05
```

### Default ETF universe

```text
VTI   US total stock market
SCHD  US dividend equity
IWM   US small-cap equity
```

The watchlist is configurable, but the default regime allocations are designed
for these three ETFs.

## 4. Execution Schedule

The Oracle server runs the PAPER service approximately every 15 minutes.

Normal execution is allowed only during the US regular session:

```text
Monday-Friday
09:30-16:00 America/New_York
```

Daylight saving time is handled through the `America/New_York` time zone.

Outside regular hours, the runner normally exits before requesting a Toss token
or market prices. A manual `--force` option exists for diagnostics.

## 5. Signal Stack

The strategy uses three signal layers:

```text
FRED macro score
    +
confidence-adjusted news sentiment
    +
confidence-adjusted moving-average trend (Faber 200-day)
    +
small confidence-adjusted MACD contribution
```

### 5.1 FRED macro score

The macro layer evaluates:

- Federal Funds target range
- 90-day policy-rate change
- Core PCE level
- Three-observation Core PCE change
- Three-observation unemployment change
- Sahm recession indicator
- US 10-year minus 2-year Treasury spread

Current heuristic scoring includes:

```text
90-day rate cut of at least 0.25 percentage points       +1
90-day rate increase of at least 0.25 percentage points  -1
Core PCE at or below 2.5%                                 +1
Core PCE at or above 3.0%                                 -1
Core PCE decline of at least 0.2 points                   +1
Core PCE increase of at least 0.2 points                  -1
Unemployment increase of at least 0.3 points              -1
Sahm value at or above 0.50                               -3
Sahm value from 0.35 to below 0.50                        -1
Negative 10Y-2Y spread                                    -1
10Y-2Y spread at or above 0.20                            +0.5
```

These thresholds are experimental assumptions, not validated forecasting rules.

### 5.2 News sentiment

Official information sources:

- Federal Reserve RSS feeds
- GDELT economic-news search

Optional opinion sources:

- Public Bluesky authors
- Substack or other RSS feeds

Official reporting and opinion content are analyzed separately. Opinion content
has a default auxiliary weight of `0.1`. If only opinion content is available,
its confidence is reduced by the same factor.

The default sentiment provider is a local rule-based analyzer. An optional local
Ollama model can be used. The analyzer returns:

```json
{
  "sentiment_score": 0,
  "confidence": 0,
  "summary_reason": "",
  "bullish_signals": [],
  "bearish_signals": []
}
```

The contribution is:

```text
sentiment contribution
    = sentiment score
    × confidence
    × sentiment weight
```

Default sentiment weight:

```text
2.0
```

### 5.3 MACD confirmation

MACD is computed from the same daily closes the trend signal already downloads,
so it needs no extra request.

MACD configuration:

```text
Fast EMA:       12
Slow EMA:       26
Signal EMA:      9
Minimum samples: 34 daily closes
Histogram scale: 0.5% of price
Default weight:  0.15
```

The MACD histogram is normalized relative to price and converted to a bounded
score using `tanh`. Confidence combines:

- Coverage: how many watchlist symbols are ready
- Directional agreement: whether ready ETFs point in the same direction

The MACD contribution is:

```text
MACD contribution
    = MACD score
    × MACD confidence
    × MACD weight
```

MACD ran on 15-minute price snapshots until 2026-08-03. That window needed 34
samples (8.5 hours) but a regular session is only 6.5 hours, so it stitched the
overnight gap into a single step and behaved as an intraday indicator driving a
daily allocation — its sign flipped on 4 of 6 consecutive sessions. It now uses
daily closes. The 15-minute snapshot file is still written, for diagnostics only.

Important limitation: the contribution ceiling is weight x 1.0 = 0.15 while the
regime band spans 3.0, so MACD alone cannot move the regime. It is a small
confirmation signal, not a timing signal.

### 5.4 Moving-average trend (Faber)

Based on Faber (2007), "A Quantitative Approach to Tactical Asset Allocation."
Daily closes are fetched from Yahoo Finance, falling back to Stooq (no API key),
and cached
in `data/trend-snapshot.json`, refreshed at most once per ~20 hours with a
stale-cache fallback on failure.

```text
Moving average:            200 trading days (≈ 10 months)
Score:                     tanh((price / MA - 1) / 5%)   bounded to [-1, 1]
Default trend weight:      1.0
```

Faber's original rule is binary (hold above the average, cash below). This
implementation keeps the trend-filter intent but converts it to a continuous
score to soften whipsaw near the average. The aggregate confidence combines
symbol coverage and directional agreement, like the MACD layer.

### 5.5 Combined score

```text
base score
    = FRED score + sentiment contribution

final score
    = base score + trend contribution + MACD contribution
```

Regime thresholds:

```text
final score >=  1.5  -> RISK_ON
final score <= -1.5  -> RISK_OFF
otherwise            -> NEUTRAL
```

## 6. Target Allocations

### RISK_ON

```text
VTI   70%
SCHD  15%
IWM   15%
CASH   0%
```

### NEUTRAL

```text
VTI   70%
SCHD  20%
IWM    0%
CASH  10%
```

### RISK_OFF

```text
VTI   40%
SCHD  20%
IWM    0%
CASH  40%
```

The regime changes target weights for both purchases and sales. A single no-trade
band (default 5% of equity) now gates **both** sides: the engine only buys when a
holding is below target by more than the band, and only trims when it is above
target by more than the band. Rebalancing sells still run while a loss brake has
paused new purchases, so a defensive regime change reduces exposure immediately.

### 6.1 Churn controls

Added 2026-08-03 after the first 8 PAPER sessions showed cumulative trading costs
(-$0.16) exceeding cumulative P&L (-$0.15) — the strategy was flat before costs.

```text
Symmetric band       buys use the same 5% band as sells   (was: $1 deficit)
regimeConfirmCycles  4    consecutive cycles = 1 hour     (was: instant)
maxRebalancesPerDay  1    per regime, per day             (was: unlimited)
```

The band was previously applied to sells only, while buys triggered at a $1
deficit. With a $10 daily buy cap, the engine bought $10 and rebalanced roughly
$10 back out on the same day — around 50% daily turnover at 0.1% per fill.

Regime confirmation holds the previous regime's target weights until a new regime
persists for `regimeConfirmCycles`. The score and all diagnostics still show the
latest values; only the allocation is held, and the report prints the pending
regime. A confirmed regime change re-enables rebalancing immediately, so the
daily cap never blocks genuine defensive de-risking.

## 7. PAPER Cycle

Each cycle follows this order:

```text
1. Validate PAPER-only mode
2. Load current ETF prices into a price map
3. Initialize or update daily risk tracking
4. Evaluate exits for every agent-opened position
5. Execute PAPER exits and update cash
6. Apply a re-entry cooldown to sold symbols
7. Evaluate total and daily loss brakes
8. Stop new purchases if a loss brake is active
9. Otherwise, calculate target-allocation deficits
10. Buy the least-fulfilled eligible target
11. Repeat within order, daily, cash, and target limits
12. Persist state atomically
```

Exits deliberately run before purchases.

## 8. Purchase Selection

For each eligible ETF:

```text
target value
    = current total equity × target weight

deficit
    = target value - current market value

fulfillment
    = current market value / target value
```

The ETF with the lowest fulfillment ratio is considered first. Ties are broken
by target value and watchlist order.

The requested order is limited by:

- Remaining daily buy allowance
- Remaining investable amount after preserving target cash
- ETF target deficit
- Available PAPER cash
- Per-order maximum
- Minimum order size

Current defaults:

```text
Maximum per order:      USD 5
Minimum order:          USD 1
Maximum daily purchase: USD 10
```

Orders below USD 1 are skipped. This prevents repeated USD 0.02-0.04
micro-purchases caused by small price movements around a target weight.

## 9. Exit Rules

Only positions with `openedByAgent: true` are eligible for automatic exits.
Real-account holdings are outside the PAPER engine.

### 9.1 Stop loss

```text
Sell when current return <= -3%
```

The return is measured against the current weighted-average entry price.

### 9.2 Trailing-profit exit

The exit becomes eligible after the position has reached:

```text
Peak return >= 2.5%
```

It sells when the subsequent drawdown from the recorded peak reaches:

```text
Peak drawdown >= 1.5%
```

### 9.3 Maximum holding period

```text
Sell after 15 days
```

The holding period begins when the position is first opened. Additional
purchases do not currently reset the opening timestamp.

### 9.4 Re-entry cooldown

After any full exit:

```text
Default cooldown: 24 hours
```

The symbol is excluded from new purchases during the cooldown, then becomes
eligible again if the target allocation still calls for it.

This replaced the previous behavior that permanently excluded any symbol after
its first full exit.

## 10. Loss Brakes

Current defaults:

```text
Maximum total PAPER loss: USD 10
Maximum daily PAPER loss: USD 3
```

When either limit is reached:

- New purchases stop
- Existing exit evaluation continues
- The risk state is saved
- The Telegram report can show the pause reason

Important distinction: the loss brake does **not** immediately liquidate every
open position. It is currently a buy-stop mechanism, while position exits remain
governed by stop loss, trailing profit, and maximum holding period.

## 11. Failure Behavior

### Macro signal unavailable

If FRED and its usable cache are unavailable:

- Existing exit checks continue
- New purchases stop

### News unavailable

If current news sources fail:

- A usable stale cache may be used
- Otherwise the system falls back to FRED plus MACD

### MACD unavailable or not ready

- MACD contribution becomes zero
- FRED and available sentiment continue

### Market price missing

- The affected symbol is skipped
- It is not evaluated or traded without a current usable price

### Overlapping runner

- A lock file prevents a second PAPER process from running concurrently

## 12. State and Accounting

The PAPER state stores:

- Original funding and exchange rate
- Current cash
- Realized P&L
- Open positions
- Weighted-average entry prices
- Per-position peaks
- Completed-symbol history
- Re-entry cooldowns
- Daily purchased amounts
- Daily and total risk state
- Full PAPER trade list
- Latest compact market signal
- Last execution timestamp

Position market value:

```text
quantity × latest observed price
```

Unrealized P&L:

```text
market value - position cost
```

Total equity:

```text
cash + total position market value
```

Total P&L:

```text
total equity - initial funded USD
```

The model supports fractional PAPER quantities. It currently does not model
broker-specific fractional-order restrictions.

## 13. Telegram Reporting

The daily report is scheduled for 16:10 New York time on weekdays.

It includes:

- New York trading date
- Initial capital
- Total equity
- Cash
- ETF market value
- Total P&L
- Realized P&L
- Unrealized P&L
- Trade count
- Combined regime and score
- News and MACD diagnostics when available
- Target allocation
- Current positions
- Trades executed on the reporting date
- Risk-brake status
- PAPER-mode disclaimer

The application records only the most recent reported trading date and send
time. It does not currently keep a server-side append-only archive of every
Telegram message body.

## 14. Early Observed Results

Observation period:

```text
2026-07-14 through 2026-07-22
```

Observed summary:

```text
Initial equity:        USD 67.05
Last reported equity:  USD 67.07
Total P&L:             USD +0.02
Approximate return:    +0.03%
Trades:                17
Observed low P&L:      USD -0.14
Primary ETFs:          VTI, SCHD
Regime path:           RISK_OFF -> NEUTRAL
```

One SCHD position with approximately USD 13.10 cost was sold for USD 13.22 by
the trailing-profit rule, producing approximately USD 0.12 realized PAPER
profit.

These results are too short and too small to support any conclusion about
strategy quality or expected return.

## 15. Issues Found and Changes Made

### Micro-order churn

Observed behavior:

```text
Repeated VTI purchases of USD 0.02-0.04
```

Cause:

- The engine attempted to match the target percentage down to one cent

Change:

- Added a default USD 1 minimum order

### Permanent post-exit exclusion

Observed behavior:

- SCHD was sold successfully
- It could never participate in target allocation again

Cause:

- A completed-symbol list was used as a permanent exclusion list

Change:

- Replaced permanent exclusion with a 24-hour cooldown

### Unenforced portfolio loss settings

Observed behavior:

- Daily and total loss values were loaded from configuration
- They were not used by the purchase path

Change:

- Added actual daily and total loss checks
- A breach now pauses new purchases

### Incomplete P&L explanation

Observed behavior:

- Telegram showed total P&L only

Change:

- Added separate realized and unrealized P&L lines

## 15.5 Transaction Costs and Volatility Management (2026-07-26)

### Combined transaction cost

Each simulated fill now applies a per-side cost rate (`TRADE_COST_RATE`,
default 0.1%) as a single combined proxy for brokerage fees, FX spread, and
slippage. On a buy it reduces the shares received for the same cash outlay; on a
sell it reduces proceeds. Cumulative cost is tracked as `feesUsd` and shown in
the report. The buy-and-hold benchmark also pays this cost once on entry, so the
comparison is net of costs on both sides.

### Volatility-managed exposure

Based on Moreira & Muir (2017), "Volatility-Managed Portfolios." Using the daily
closes already fetched for the trend signal, the system estimates recent
annualized volatility and scales equity exposure by
`clamp(volTarget / realizedVol, minExposure, 1)`
(`VOL_TARGET_ANNUALIZED` default 0.15, `MIN_EXPOSURE` default 0.3). When markets
are calmer than target the multiplier is 1 (no change); when they are more
volatile, equity weights shrink and the remainder moves to cash. The symmetric
rebalancing logic then trims real exposure down to the reduced target.

## 16. Known Modeling Limitations

Transaction costs are now modeled as a single combined per-trade rate; the items
below are still not separately modeled and may make results optimistic:

- Separate bid/ask spread, brokerage fee, and FX components (currently one blended rate)
- Partial fills
- Rejected orders
- Market impact
- Delayed or stale quote penalties
- Broker-specific minimum notional rules
- Tax effects
- Dividend and withholding-tax accounting
- Corporate actions
- Exchange holidays and early-close calendars beyond weekday/session checks
- Survivorship or look-ahead controls for a formal backtest

Additional strategy limitations:

- Macro thresholds are hand-designed initial hypotheses
- FRED series have different release frequencies and publication lags
- News sentiment is not yet calibrated against forward returns
- Opinion-source quality is not scored per author
- MACD uses snapshots rather than official candles
- Target allocation changes do not trigger full rebalancing sales
- Maximum holding time applies to the whole averaged position
- There is no benchmark engine yet
- The observed evaluation period is extremely short

## 17. Questions for Trading and Risk Reviewers

External advisors are invited to review the following:

1. Are the RISK_ON, NEUTRAL, and RISK_OFF allocations defensible for the chosen
   ETF universe?
2. Are the macro thresholds statistically meaningful, or are they likely to
   overfit intuitive narratives?
3. Should the news layer change allocations, position size, or only reporting
   confidence?
4. Is 12/26/9 MACD appropriate for 15-minute sampled prices?
5. Should MACD be replaced with official OHLCV candles and a volatility-adjusted
   trend measure?
6. Is a USD 1 minimum order enough, or should the system use both a minimum
   amount and a percentage-band rebalancing threshold?
7. Should re-entry cooldown depend on exit reason?
   - Stop loss: longer cooldown
   - Trailing profit: shorter cooldown
   - Maximum holding period: require a new signal
8. Should the total-loss brake liquidate positions or only block new purchases?
9. Should daily risk be based on previous close, first intraday observation, or
   marked equity at a fixed New York time?
10. How should realized loss, unrealized loss, and drawdown interact with risk
    limits?
11. What benchmark is most appropriate: VTI buy-and-hold, a static
    VTI/SCHD/cash portfolio, or both?
12. What minimum PAPER duration and sample size should be required before
    considering a strategy revision?
13. Which transaction-cost model is appropriate for Toss fractional US ETF
    trading?
14. What approval, audit, and kill-switch design would be mandatory before any
    live-order prototype?

## 18. Proposed Evaluation Plan

Before considering live execution:

1. Collect at least 30-60 trading days of uninterrupted PAPER data.
2. Store an append-only record of every signal, decision, and simulated fill.
3. Add fees, spread, slippage, and rejected-order assumptions.
4. Compare against VTI buy-and-hold and a static allocation benchmark.
5. Report:
   - Total return
   - Maximum drawdown
   - Volatility
   - Turnover
   - Win/loss ratio
   - Profit factor
   - Exposure by regime
   - Performance before and after modeled costs
6. Test stale data, API failure, server restart, and corrupted-state scenarios.
7. Require an independent code and risk review.
8. Keep live trading disabled until the user explicitly approves a separately
   designed execution layer.

## 19. Disclaimer

This document describes an experimental PAPER trading system. It is not
investment advice, does not claim profitability, and should not be used as a
basis for live trading without independent financial, technical, operational,
and legal review.

