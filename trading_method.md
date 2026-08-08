# TAPIoca Trading Method

> Strategy specification for external review  
> Last updated: 2026-08-08
>
> This document describes **the rules as they run now**. The evidence behind each
> number is in `STRATEGY.md`; the investigation that produced it is in
> `develope-log/`.

## 1. Purpose

TAPIoca is an experimental asset-allocation agent for US ETFs. It combines
macroeconomic, news-sentiment, and price-trend signals into a target allocation,
then simulates purchases and exits in a file-based PAPER wallet.

The objective is **not** to prove profitability. Measured over 20 years of real
daily closes, the strategy has **no return advantage** — it trades roughly
1.9-2.6 percentage points of annual return for 12-23 points of maximum drawdown.

> **In one line: this is not a machine for earning more than the market. It is a
> machine for losing less.** That is a deliberate trade.

What is being validated: safety constraints, decision traceability, state
persistence, automated operation, report usefulness, and behavior across regimes.

## 2. Live Execution Status

The repository contains a live order execution layer, and it has placed real
orders — two confirmation orders on 2026-08-07.

```text
Scheduled runner (every 15 min)   PAPER only. Refuses any non-PAPER mode.
Live orders                       Human runs a CLI with an explicit --confirm.
Automatic live trading            Does not exist. No timer can place an order.
```

The purpose of live orders is **not** return. It is measuring execution cost:
whether slippage plus FX fit inside the 10bp the backtest assumes. See §17.

## 3. Non-Goals

The strategy is not a high-frequency system, a market-making strategy, a
same-asset simultaneous buy/sell strategy, a statistical-arbitrage system, or an
options/leveraged-products strategy.

It does not intentionally buy and sell the same ETF at once. Exits are evaluated
before purchases, and a sold symbol enters a re-entry cooldown.

## 4. PAPER Capital and Universe

```text
Initial capital     KRW 100,000 hard cap  ->  observed USD 67.05
```

The initial KRW amount is converted to USD once using the Toss exchange rate,
rounding down to cents so the KRW-funded amount cannot exceed the cap.

```text
VTI   US total stock market
SCHD  US dividend equity
IWM   US small-cap equity
```

The watchlist is configurable, but the default regime allocations are designed
for these three ETFs.

## 5. Execution Schedule

The Oracle server runs the PAPER service approximately every 15 minutes, and only
during the US regular session:

```text
Monday-Friday, 09:30-16:00 America/New_York
```

Daylight saving is handled through the `America/New_York` time zone. Outside
regular hours the runner exits before requesting a Toss token or market prices.
A manual `--force` option exists for diagnostics.

## 6. Signal Stack

```text
combined score
    = macro score      × MACRO_SCORE_WEIGHT
    + sentiment score  × sentiment confidence × SENTIMENT_SCORE_WEIGHT × freshness
    + trend score      × trend confidence     × TREND_SCORE_WEIGHT
    + MACD score       × MACD confidence      × MACD_SCORE_WEIGHT
```

### 6.0 Current weights — only one layer moves the allocation

| Layer | Weight | Why |
|---|---:|---|
| Macro (FRED) | **0** | While constant it is an exposure dial, not a signal (Sharpe sign agreement 0/4). When it does move it is harmful on average — an edge in the 2008 sample only, worse in the other three |
| Sentiment | **0** | **Held, not concluded.** An unjudged layer was cutting exposure by ~6.6pp, and the backtester omits sentiment entirely, so production was running a stack that had never been measured. Samples keep accumulating |
| Trend | **1** | Lower drawdown than 0.5 (4/4) and higher Sharpe than 2 (4/4). Blocked on both sides |
| MACD | **0** | Contribution ceiling is smaller than the no-trade band, so it can never by itself cause an order |

**A layer at weight 0 is still computed and still logged.** Raw scores go into the
event log regardless of weight (`market-signal.js` passes them through), so the
layer can be judged later from the accumulated sample.

### 6.1 Macro score (FRED)

Inputs: Federal Funds target range, 90-day policy-rate change, Core PCE level and
three-observation change, three-observation unemployment change, the Sahm
recession indicator, and the 10Y-2Y Treasury spread.

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

These thresholds are hand-designed hypotheses, not validated forecasting rules.

**In backtests the layer is reconstructed from FRED vintages.** FRED returns
*revised* values by default; querying 2008 unemployment today returns a figure
nobody had at the time. Filtering on `realtimeStart` — the date a value became
public — restores what was actually knowable, and handles publication lag as a
side effect. This error is dangerous specifically because it makes results look
good. Revision-free series (e.g. `T10Y2Y`) use the observation date instead,
since their vintage history only reaches back ~12 years.

### 6.2 News sentiment

Official sources: Federal Reserve RSS, GDELT economic-news search, Google News
RSS. Optional opinion sources: public Bluesky authors, Substack/other RSS.

```text
official  FED_RSS + GDELT + GOOGLE_NEWS   weight 1.0
opinion   BLUESKY + OPINION_RSS           weight OPINION_SCORE_WEIGHT (0.1)
final     (official + w × opinion) / (1 + w)
```

If only opinion content is available, its confidence is reduced by the same
factor. The default analyzer is a local rule-based scorer; an optional local
Ollama model can be substituted. Output schema:

```json
{
  "sentiment_score": 0,
  "confidence": 0,
  "summary_reason": "",
  "bullish_signals": [],
  "bearish_signals": []
}
```

**Per-source success and failure is recorded on every snapshot.** Without that, a
dead source silently shrinks the sample and the layer looks stable when it is
merely starved. GDELT 429s trigger a back-off rather than a retry.

```text
Cache:         60 minutes  (NEWS_CACHE_MINUTES)
Half-life:      6 hours    (SENTIMENT_HALF_LIFE_HOURS)
Cutoff:        24 hours    (SENTIMENT_MAX_AGE_HOURS) -> contribution 0
Unknown time:  no decay
```

The cache was 15 minutes — the same as the PAPER cycle — so every cycle refetched,
GDELT was called ~96 times a day, and it answered 429. Sentiment feeds a daily
decision; 15-minute freshness bought nothing.

Age decay exists because a reused snapshot once repeated to three decimal places
for four straight days, crossed a regime boundary, and flipped the equity weight.
The report now prints snapshot age so that case is visible without reading logs.

> **The analyzer is keyword matching, not comprehension.** Fed statements use
> "recession", "inflation" and "rate hike" as neutral technical vocabulary, which
> the matcher reads as bearish. That is why the official layer sat near -0.65 for
> twelve days whenever GDELT was absent. This is the open question the layer is
> currently being judged on.

### 6.3 Moving-average trend (Faber)

Based on Faber (2007), "A Quantitative Approach to Tactical Asset Allocation."

```text
Moving average:       200 trading days (≈ 10 months)
Score:                tanh((price / MA - 1) / 5%)   bounded to [-1, 1]
Default weight:       1.0
```

Daily closes come from Twelve Data when `TWELVE_DATA_API_KEY` is set, falling back
to Yahoo Finance and then Stooq, cached in `data/trend-snapshot.json` and
refreshed at most once per ~20 hours with a stale-cache fallback. In practice
both keyless sources are blocked from the Oracle host, so the key is required.

Faber's original rule is binary (hold above the average, cash below). This
implementation keeps the intent but uses a continuous score to soften whipsaw near
the average. Confidence combines symbol coverage and directional agreement.

**This is currently the only layer that moves the allocation.**

### 6.4 MACD confirmation

```text
Fast EMA:       12
Slow EMA:       26
Signal EMA:      9
Minimum samples: 34 daily closes
Histogram scale: 0.5% of price
Default weight:  0
```

Computed from the same daily closes the trend layer downloads, so it costs no
extra request. The histogram is normalized to price and bounded with `tanh`;
confidence combines coverage and directional agreement.

**Weight 0 for two independent reasons.** Arithmetically, at 0.15 the contribution
ceiling is 0.15 against a regime band spanning 3.0, and with a 5% no-trade band
the largest weight change it can produce is smaller than the band — it could never
by itself cause an order. Empirically, weights of 0 / 0.15 / 0.5 / 1.0 over 20
years showed no edge that replicated across samples.

MACD is still computed and reported as a diagnostic.

### 6.5 Score to allocation

Regime labels, used for reporting and trade tags only:

```text
combined score >=  1.5  -> RISK_ON
combined score <= -1.5  -> RISK_OFF
otherwise               -> NEUTRAL
```

**The label does not set the weights.** Targets interpolate continuously between
the three anchor tables:

```text
score <= -1.5            RISK_OFF table exactly
-1.5 < score < 0         blend(NEUTRAL, RISK_OFF, -score / 1.5)
score == 0               NEUTRAL table exactly
0 < score < 1.5          blend(NEUTRAL, RISK_ON,   score / 1.5)
score >=  1.5            RISK_ON table exactly
```

The previous step function put a 30-percentage-point jump in equity weight on a
single score value, and flipped the target daily while the score oscillated
between -1.2 and -2.3. Interpolating turns a 0.1 score move into a 2-point weight
drift, which stays inside the no-trade band and produces no order.

## 7. Target Allocations

| Regime | VTI | SCHD | IWM | Cash |
|---|---:|---:|---:|---:|
| RISK_ON | 70% | 15% | 15% | 0% |
| NEUTRAL | 70% | 20% | 0% | 10% |
| RISK_OFF | 40% | 20% | 0% | 40% |

The regime changes targets for both purchases and sales.

## 8. Volatility-Managed Exposure

Based on Moreira & Muir (2017), "Volatility-Managed Portfolios."

```text
exposure multiplier = clamp(volTarget / realizedVol, MIN_EXPOSURE, MAX_EXPOSURE)

VOL_TARGET_ANNUALIZED   0.15
MIN_EXPOSURE            0.3
MAX_EXPOSURE            1
```

Realized annualized volatility is estimated from the daily closes already fetched
for the trend layer. When markets are calmer than target the multiplier is 1; when
more volatile, equity weights shrink and the remainder moves to cash. Symmetric
rebalancing then trims real exposure down to the reduced target.

**This layer is the source of 84-99% of the strategy's measured advantage.**

Two settings were tested and rejected:

- `VOL_TARGET_ANNUALIZED = 0.20` looks better on Sharpe in all four sub-periods,
  but costs 5.28pp of drawdown once 2008 is included. The pre-registered tolerance
  was 3pp. Both directions are 4/4 — it is a real trade-off, not noise, and we buy
  drawdown.
- `MAX_EXPOSURE = 1.2` made CAGR, Sharpe, MDD **and** CDaR worse in all four
  sub-periods. Rejected.

## 9. Trade Gating

```text
REBALANCE_BAND_RATE   0.05     no-trade band, both sides
TARGET_DRIFT_CAP      2        force a return once drift exceeds 2× the band
regimeConfirmDays     1        1 trading day = 26 cycles
maxRebalancesPerDay   1        per regime, per day
Minimum order         USD 1
```

A single no-trade band gates **both** sides: the engine buys only when a holding
is below target by more than the band, and trims only when above by more than the
band. It was previously sells-only while buys triggered at a $1 deficit, which
with a $10 daily cap produced roughly 50% daily turnover.

**Band width 0.05 was confirmed against 1% and 10% across four sub-periods.**

| Band | CAGR% | Sharpe | MDD% | Fills | Turnover/yr |
|---|---:|---:|---:|---:|---:|
| 1% | 8.097 | 0.759 | 19.194 | 1675 | 3.313 |
| **5%** | **8.165** | **0.773** | **18.735** | **323** | **1.655** |
| 10% | 8.299 | 0.752 | 19.743 | 130 | 0.915 |

10% is 4/4 worse on Sharpe. 1% wins 4/4 on drawdown but by 0.276pp — a fifth of
what trend buys in a crash and a fortieth of what volatility management buys — for
double the turnover and 5.2× the fills.

> **Caveat on the 1% row:** with `fundedUsd = 67.05` and `minOrderUsd = $1`, the
> band is `max($1, rate × equity)`, so 1% is clamped to an effective 1.49% at
> inception and loosens as equity grows. Below ~1.5% the band rate is not
> expressible at this account size.

**Direction asymmetry, and the drift cap.** Because the band scales with equity,
a drift that opened when the account was smaller can stay open — the band grows
past it. `TARGET_DRIFT_CAP=2` forces a return once drift exceeds twice the band,
regardless. Adopted 2026-08-07; price is 0.152pp of CAGR. It covers about half the
problem; the remainder is open (see §17).

Regime confirmation holds the previous regime's targets until a new regime
persists for `regimeConfirmDays`, expressed internally as 15-minute cycles
(`REGIME_CONFIRM_CYCLES` overrides directly). Scores and diagnostics still show
the latest values; only the allocation is held, and the report prints the pending
regime. A confirmed regime change re-enables rebalancing immediately, so the daily
cap never blocks genuine defensive de-risking.

Cash released by a defensive sale is exempt from the daily and per-order buy caps
(`redeployableUsd`). Selling is instantaneous while buying was throttled, so a
defensive round trip used to cost five sessions of exposure. The caps now limit
only how much **new** capital enters per day, not how fast the engine returns to
its own target.

## 10. PAPER Cycle

```text
 1. Validate PAPER-only mode
 2. Load current ETF prices into a price map
 3. Initialize or update daily risk tracking
 4. Evaluate exits for every agent-opened position
 5. Execute PAPER exits and update cash
 6. Apply a re-entry cooldown to sold symbols
 7. Evaluate total and daily loss brakes
 8. Record an alert if a brake fired (trading continues — see §12)
 9. Calculate target-allocation deficits
10. Buy the least-fulfilled eligible target
11. Repeat within order, daily, cash, and target limits
12. Append the cycle to the event log
13. Persist state atomically
```

Exits deliberately run before purchases.

## 11. Purchase Selection

```text
target value  = current total equity × target weight
deficit       = target value - current market value
fulfillment   = current market value / target value
```

The ETF with the lowest fulfillment ratio is considered first; ties break by
target value and watchlist order. The order is limited by remaining daily buy
allowance, remaining investable amount after preserving target cash, the deficit,
available cash, per-order maximum, and minimum order size.

```text
Maximum per order:      USD 5
Minimum order:          USD 1
Maximum daily purchase: USD 10
```

Orders below USD 1 are skipped, preventing repeated $0.02-0.04 micro-purchases
around a target weight.

## 12. Exit Rules

Only positions with `openedByAgent: true` are eligible for automatic exits.
Real-account holdings are outside the PAPER engine.

### Stop loss

```text
Sell when return <= -12%   (STOP_LOSS_RATE)
```

Measured against the current weighted-average entry price. **This is a disaster
brake, not a trading rule.** The previous 3% threshold triggered on ordinary
index-ETF movement and emptied positions while the allocation layer still targeted
70% equity.

Measurement shows the stop rarely fires and does not contribute to crash defense —
outcomes are effectively identical across threshold values. Treat it as insurance
against a tail the sample does not contain. `STOP_LOSS_SIGMA` (a volatility-scaled
variant) is implemented but left off: its improvement is below noise.

### Trailing-profit exit — **disabled by default**

```text
TRAILING_ACTIVATION_RATE  off   (previously 2.5%)
TRAILING_DRAWDOWN_RATE    off   (previously 1.5%)
```

Set both in `.env` to enable; `off` or `none` disables them again. Recommended
only for an individual-stock watchlist. On index ETFs this rule sold entire
positions on routine fluctuation.

### Maximum holding period — **disabled by default**

```text
MAX_HOLDING_DAYS  off   (previously 15 days)
```

A long-term allocation has no reason to sell purely because time passed. When
enabled, the holding period begins when the position is first opened; additional
purchases do not reset the timestamp.

> Together, these two rules raised turnover roughly 21× over 20 years for no
> return improvement.

### Re-entry cooldown

```text
Default cooldown: 24 hours
```

The symbol is excluded from new purchases during the cooldown, then becomes
eligible again if the target allocation still calls for it. This replaced earlier
behavior that permanently excluded a symbol after its first full exit.

## 13. Loss Brakes — Alerts, Not Stops

```text
Maximum total PAPER loss: USD 10
Maximum daily PAPER loss: USD 3
```

When either limit is reached the engine **changes nothing about trading**:

- A `RISK_ALERT` decision is recorded and the risk state is saved
- The Telegram report shows the warning and states that trading continues
- Purchases, rebalancing and exits proceed exactly as before

**Halting on a loss limit was measured over 20 years and made outcomes worse:** it
disabled risk management precisely during a crash and raised maximum drawdown from
29.8% to 51.6%. A 10% limit was the worst variant tested.

The mechanism was an absorbing state. Buying stopped while defensive selling
continued, so the portfolio drained to all cash and never re-entered; equity froze
for the remaining seventeen years. Freezing exits as well did not fix it. **What to
do about a loss belongs to a person looking at the alert.**

See `develope-log/2026-08-06_사후분석과-백테스터.md` for the comparison table.

## 14. Transaction Costs

```text
TRADE_COST_RATE   0.001 (10bp) per side
```

A single combined proxy for brokerage fees, FX spread, bid/ask and slippage. On a
buy it reduces shares received for the same cash; on a sell it reduces proceeds.
Cumulative cost is tracked as `feesUsd` and reported. Both benchmarks pay the same
one-off entry cost, so comparisons are net of costs on both sides.

**Measured on the real account (2026-08-07, two orders): commission is currently
`$0`.** At $10 a 0.1% fee would have shown $0.01; it showed nothing.

The rate is **not** being lowered. It covers slippage and FX as well, and neither
has been measured yet — amount orders are market orders, so the fill price is not
ours to choose. Toss `/commissions` also lists the US waiver ending 2026-08-08 at
a 0.1% rate, which would land exactly on the assumption.

## 15. Failure Behavior

| Condition | Behavior |
|---|---|
| Macro signal and cache unavailable | Exit checks continue; new purchases stop |
| News sources fail | Usable stale cache may be used; otherwise the layer is dropped |
| MACD unavailable or not ready | Contribution becomes zero; other layers continue |
| Market price missing | Symbol is skipped — never traded without a usable price |
| Overlapping runner | A lock file prevents a second PAPER process |
| Live: any unresolved order | No new order is submitted |
| Live: unknown broker status | Halt and require human review |
| Live: `data/EMERGENCY_STOP` exists | No order is submitted, from the next cycle |

## 16. State, Accounting and Benchmarks

The PAPER state stores original funding and exchange rate, current cash, realized
P&L, open positions with weighted-average entry prices and per-position peaks,
completed-symbol history, re-entry cooldowns, daily purchased amounts, daily and
total risk state, the full trade list, the latest compact market signal, and the
last execution timestamp.

```text
position market value = quantity × latest observed price
unrealized P&L        = market value - position cost
total equity          = cash + total position market value
total P&L             = total equity - initial funded USD
```

Fractional PAPER quantities are supported. Broker-specific fractional-order
restrictions are not modeled in PAPER (the live layer handles them separately).

### Benchmarks

```text
VTI buy-and-hold     100% VTI                        -> alpha
Policy mix           VTI 70 / SCHD 20 / cash 10      -> signal excess return
```

Both are fixed at inception and pay the same one-off entry cost. The policy mix is
the NEUTRAL anchor held **without rebalancing** — the strategy's own allocation
with the signals removed. It is risk-matched, so the gap against it isolates what
the signal layers contribute; the gap against 100% VTI mixes that with the cost of
deliberately holding cash.

**Neither benchmark reacts to what the strategy does.** A benchmark that waived
the penalty while the strategy was defensive would excuse exactly the days the
signals were wrong — which is when the comparison matters most.

### Alpha attribution

Alpha is split per cycle:

```text
designed cost = (target equity weight - 1) × benchmark return
shortfall     = (actual - target)          × benchmark return
```

The first is the price of deliberately holding cash — a risk decision. The second
is failing to reach the target — a bug. **The correct response to each is
opposite**, so they are never reported as one number. Weights are taken at the
*start* of each interval, so a large mid-interval sale lands in the residual
rather than the shortfall; only sustained under-allocation is caught. The
sum-vs-actual gap is reported as `compoundingUsd` rather than hidden.

When this was first run, 80% of the observed negative alpha was shortfall — a
mechanical defect, not signal quality. Structural cash drag was +$0.02, i.e.
essentially zero.

## 17. Measured Results and Open Questions

### 20 years of real daily closes (2006-2026)

```text
CAGR         5.99%
MDD          29.9%
Avg exposure 75.6%
```

The production stack (macro 0 · sentiment 0 · trend 1 · MACD 0 · volTarget 0.15)
is **exactly** the stack the backtester measures, so PAPER results are directly
comparable to these numbers.

| Claim | Status |
|---|---|
| Beats static allocation on drawdown | **Yes** — 10-16pp after matching exposure |
| Beats static allocation on return | **No** — no defensible advantage |
| Source of the advantage | Volatility management (84-99%); trend is largely redundant, its residual value confined to samples containing 2008 |
| "Almost always" wins on drawdown | Correct — 3/4 sub-periods, not 4/4 |

### Open questions

1. **Is the sentiment layer signal or noise?** Judgment date 2026-08-20~21, once
   10 trading days of snapshots accumulate. Criteria were written before the
   result (`STRATEGY.md` §3). The prior concern is that the value barely moves —
   a "does it move at all" gate runs before autocorrelation for that reason.
2. **Do slippage and FX fit inside 10bp?** The measurement layer exists
   (`npm run live:slippage`); the sample does not. This is the purpose of running
   live alongside PAPER.
3. **Does order timing matter?** Both live orders went in at 09:34 and 09:38 ET —
   the widest-spread window. The amount-order window is 09:30-15:00, so the
   executor can submit there. Whether to avoid the open is unmeasured.
4. **The remaining half of the band asymmetry.** The drift cap covers about half.
5. **Should the live executor ever be wired to the scheduler?** Not decided.

### Known modeling limitations

Still not separately modeled, and may make results optimistic: separate bid/ask,
fee and FX components (one blended rate today); partial fills; rejected orders;
market impact; stale-quote penalties; broker minimum-notional rules; taxes;
dividends and withholding; corporate actions; holiday and early-close calendars
beyond weekday/session checks.

Strategy-level limitations:

- Macro thresholds are hand-designed hypotheses
- News sentiment is not calibrated against forward returns
- Opinion-source quality is not scored per author
- The live PAPER observation window is still short
- **The backtester cannot measure the sentiment layer.** It omits sentiment
  because past news windows are not reconstructable. The macro layer *is* now
  measurable via FRED vintages; sentiment is not, which is why the event log
  accumulates snapshots as the only path to eventually testing it

## 18. Operating Discipline

1. Parameters are decided in the backtester, not in live PAPER runs. Twenty
   trading days at $67 cannot separate a path-dependent rule's effect from noise.
2. Judgment criteria are written down **before** looking at the result.
3. Results are checked for **sign agreement across sub-periods**, not just a
   single full-sample average — a full-sample average does not separate an effect
   from noise.
4. Production must run the same stack the backtester measured. If they differ,
   we are running something that was never measured.
5. An unjudged layer does not get to move the allocation.
6. In live execution: **halt, do not guess.** The failure mode of guessing is a
   duplicate purchase with real money.
7. Start with the smallest real thing to find what is not ready. 314 passing tests
   still left a permanent-halt bug that only a $2 real order exposed.

## 19. Disclaimer

This document describes an experimental trading system. It is not investment
advice, does not claim profitability, and should not be used as a basis for live
trading without independent financial, technical, operational, and legal review.
