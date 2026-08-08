# TAPIoca File Structure

> Architecture snapshot for external review  
> Last updated: 2026-08-08
>
> This document describes **what the code is now**. History belongs in
> `develope-log/`; current strategy conclusions belong in `STRATEGY.md`.

## 1. Project Summary

TAPIoca reads Toss Securities account and market data, evaluates market
conditions through a stack of signal layers, and maintains a file-based PAPER
portfolio with a daily Telegram report.

Since 2026-08-07 the repository also contains a **live order execution layer**
(`src/live/`). It has placed real orders on a real account — two confirmation
orders on 2026-08-07 — but only through the manual `npm run live:probe` tool.

**The scheduled runner is still PAPER-only.** `paper-runner.js` throws if
`LIVE_TRADING` is anything other than PAPER mode. Nothing places an order
automatically today; live execution requires a human running a CLI with an
explicit `--confirm` flag.

## 2. Runtime Overview

- Runtime: Node.js 20.12 or newer
- Module system: JavaScript ES Modules
- Third-party runtime dependencies: none
- Test framework: Node.js built-in test runner
- Production host: Oracle Cloud Linux instance
- Scheduler: systemd services and timers
- Persistent storage: local JSON / JSONL files under `data/`
- Primary user interface: Telegram daily reports

## 3. Repository Tree

```text
toss-ai-agent/
├── README.md
├── file_structure.md
├── trading_method.md
├── STRATEGY.md                     # 지금 무엇이 참인가 — 현재 결론만, 계속 갱신
├── NOTION_TAPIOCA_PROJECT_OVERVIEW.md
├── develope-log/                   # 날짜별 개발 기록 — 확정된 기록, 고치지 않음
├── toss-guideline/
│   └── toss-invest-open-api-guide.md   # 브로커 API 원문 (판단 근거)
├── package.json
├── scripts/
│   └── shorttest.mjs               # 요약 출력 테스트 러너 (npm test)
├── deploy/
│   ├── toss-ai-paper.service
│   ├── toss-ai-paper.timer
│   ├── toss-ai-report.service
│   └── toss-ai-report.timer
├── src/
│   ├── toss/
│   │   ├── doctor.js
│   │   └── toss-client.js
│   ├── live/
│   │   ├── baseline-cli.js
│   │   ├── broker-contract.js
│   │   ├── emergency-stop-cli.js
│   │   ├── emergency-stop.js
│   │   ├── execution-plan.js
│   │   ├── fake-broker.js
│   │   ├── live-cycle.js
│   │   ├── live-probe.js
│   │   ├── order-lifecycle.js
│   │   ├── order-outcome.js
│   │   ├── order-store.js
│   │   ├── position-baseline.js
│   │   ├── rate-limiter.js
│   │   ├── slippage-cli.js
│   │   ├── slippage.js
│   │   ├── toss-broker.js
│   │   └── toss-order-status.js
│   ├── portfolio/
│   │   ├── analyze-cli.js
│   │   ├── cli.js
│   │   └── portfolio-analysis.js
│   ├── FRED_data/
│   │   ├── fred-client.js
│   │   ├── macro-regime.js
│   │   ├── macro-snapshot.js
│   │   └── macro-status.js
│   ├── market/
│   │   ├── macd-signal.js
│   │   ├── market-check.js
│   │   ├── signals-check.js
│   │   ├── trend-signal.js
│   │   └── us-market-session.js
│   ├── sentiment/
│   │   ├── free-news-fetcher.js
│   │   ├── market-sentiment.js
│   │   ├── market-signal.js
│   │   ├── sentiment-analyzer.js
│   │   └── sentiment-status.js
│   ├── paper/
│   │   ├── alpha-attribution.js
│   │   ├── alpha-cli.js
│   │   ├── event-log.js
│   │   ├── events-cli.js
│   │   ├── exit-strategy.js
│   │   ├── paper-engine.js
│   │   ├── paper-runner.js
│   │   ├── paper-status.js
│   │   ├── signal-history-cli.js
│   │   ├── signal-history.js
│   │   ├── trading-budget.js
│   │   └── trading-policy.js
│   ├── backtest/
│   │   ├── backtest-cli.js
│   │   ├── backtest-engine.js
│   │   ├── macro-cache.js
│   │   ├── macro-history.js
│   │   ├── price-cache.js
│   │   ├── scenarios.js
│   │   └── synthetic-prices.js
│   └── telegram/
│       ├── daily-report-format.js
│       ├── daily-report.js
│       ├── telegram-check.js
│       ├── telegram-client.js
│       └── telegram-discover.js
└── test/                           # 29 test files
    ├── alpha-attribution.test.js
    ├── backtest-engine.test.js
    ├── daily-report.test.js
    ├── event-log.test.js
    ├── exit-strategy.test.js
    ├── fred-client.test.js
    ├── free-news-fetcher.test.js
    ├── live-cycle.test.js
    ├── live-safety.test.js
    ├── macd-signal.test.js
    ├── macro-history.test.js
    ├── macro-regime.test.js
    ├── macro-snapshot.test.js
    ├── market-sentiment.test.js
    ├── market-signal.test.js
    ├── order-lifecycle.test.js
    ├── paper-engine.test.js
    ├── portfolio-analysis.test.js
    ├── rebalance-band-ratchet.test.js
    ├── sentiment-analyzer.test.js
    ├── signal-history.test.js
    ├── slippage.test.js
    ├── telegram-client.test.js
    ├── toss-broker.test.js
    ├── toss-client.test.js
    ├── trading-budget.test.js
    ├── trading-policy.test.js
    ├── trend-signal.test.js
    └── us-market-session.test.js
```

Generated runtime files are intentionally not part of the source tree:

```text
data/
├── paper-state.json                # PAPER 지갑 스냅샷 (가변)
├── paper-events.jsonl              # PAPER 사이클 이벤트 (덧붙이기 전용)
├── paper-runner.lock
├── live-orders.jsonl               # 실주문 원장 (덧붙이기 전용, 고치지 않음)
├── live-position-baseline.json     # 실거래 시작 시점의 계좌 보유 기준선
├── EMERGENCY_STOP                   # 존재하면 다음 사이클부터 주문 중지
├── telegram-report-state.json
├── macro-snapshot.json
├── macro-vintages.json             # FRED 개정 이력 캐시 (백테스트용)
├── free-news-cache.json
├── macd-snapshot.json
├── trend-snapshot.json
└── backtest-closes.json
```

## 4. Module Responsibilities

### `src/toss/`

Owns Toss Securities API communication.

- `toss-client.js`
  - OAuth2 token acquisition and in-process token reuse
  - Account discovery, portfolio retrieval, ETF price and quote retrieval
  - USD/KRW exchange-rate retrieval
  - Toss error normalization
- `doctor.js`
  - Read-only connection diagnostic
  - Verifies credentials, allowed public IP, and account visibility

### `src/live/`

Owns real order execution. The design rule throughout this directory is that
**a failure must stop the system rather than guess**, because the failure mode
of guessing is a duplicate purchase with real money.

- `broker-contract.js`
  - The explicit list of what any broker must provide for live trading to be
    safe. Judging a new broker's API is a checklist, not an impression
  - `assertBrokerContract()` fails loudly on a broker missing any requirement
- `toss-broker.js`
  - Toss Open API order adapter. Passes the same contract tests as the fake
  - Amount-based (`orderAmount`) market orders; 10-minute idempotency window
- `toss-order-status.js`
  - Maps Toss order status to internal state
  - **Unknown status values stop and ask for a human.** Toss documents that new
    status values may appear; folding an unknown value into a known state would
    produce a silently wrong decision
- `order-store.js`
  - Append-only JSONL order ledger (`live-orders.jsonl`), never rewritten
  - Kept separate from `paper-state.json`: the question here is not "what do I
    hold" but "what is the state of the order I placed", answerable after a crash
- `order-lifecycle.js`
  - Pure functions folding order events into current state
  - State is recomputed from the log every time rather than stored, so a stored
    state and the log can never disagree
  - `reconcile()` compares ledger positions against broker positions
- `order-outcome.js`
  - Translates a submission result into **what is allowed next**
  - The single place that decides resubmit-safe vs never-resubmit. Deciding this
    per call site eventually produces a duplicate buy
- `execution-plan.js`
  - Pure function deciding what to submit this cycle, or whether to halt
  - Order is priority: **all halt reasons are checked first**, then at most one
    order is emitted
- `live-cycle.js`
  - One live cycle: takes the PAPER engine's *intent* and turns it into an order
  - Intended to run alongside PAPER so the difference between the two ledgers
    measures real execution cost
- `position-baseline.js` / `baseline-cli.js`
  - The account already held unrelated assets when live trading began
    (confirmed 2026-08-07). Reconciling against an empty ledger would
    halt permanently, so reconciliation target is
    **baseline + what we filled**, not the whole account
  - `baselineFromCurrent()` reconstructs the pre-agent account as
    **current holdings − our realized fills**. The baseline must describe the
    account *before* we touched it, but it is recorded *after* — using current
    holdings as-is would fold our own purchases into "was already there", and
    `expectedPositions` would then count them twice
  - `npm run live:baseline` records it once. **Check-only without `--confirm`**,
    and it verifies `baseline + fills == current holdings` before saving —
    saving a baseline that fails that check only halts the first cycle
  - Never created automatically: a cycle that captures its own baseline would
    absorb a mistaken purchase as "originally there", where it disappears from
    reconciliation forever. `saveBaseline()` also refuses to overwrite
- `slippage.js` / `slippage-cli.js`
  - Records the quote at submission time as a baseline and measures the gap
    against the actual fill
  - Amount orders are market orders, so fill price is not ours to choose.
    Commission is currently 0, which makes the remaining cost essentially
    slippage plus FX — the question the 10bp backtest assumption depends on
  - `npm run live:slippage` summarizes the ledger's realized fills
- `rate-limiter.js`
  - Enforces Toss API call limits. The real risk is restart recovery: several
    pending orders produce back-to-back lookups, and a 429 there looks like a
    failed recovery and halts the next cycle
- `emergency-stop.js` / `emergency-stop-cli.js`
  - A **file**, not an environment variable: changing an env var requires a
    service restart, and the moment you want to stop is the moment something is
    running wrong. `npm run stop` takes effect from the next cycle
- `fake-broker.js`
  - Test broker that can produce failure modes on demand (rejection, partial
    fill, truncated response). Obeys the same contract as the real adapter
- `live-probe.js`
  - Confirms a live connection with **one order**. `npm run live:probe`
  - **Default is check-only**; no order is sent without `--confirm`

### `src/portfolio/`

Owns read-only analysis of the real Toss account.

- Retrieves domestic and US positions
- Separates currencies instead of incorrectly summing KRW and USD
- Calculates position weights and HHI concentration
- Warns about excessive single-position concentration
- Does not modify the PAPER portfolio

### `src/FRED_data/`

Owns macroeconomic data collection and regime classification.

- `fred-client.js`: downloads FRED observations and vintage (revision) dates
- `macro-regime.js`: converts macro observations into a score and regime
- `macro-snapshot.js`: caches the latest usable macro result
- `macro-status.js`: command-line diagnostic

The regime is one of `RISK_ON`, `NEUTRAL`, `RISK_OFF`.

### `src/sentiment/`

Owns free news collection and sentiment analysis.

- `free-news-fetcher.js`
  - Sources: Federal Reserve RSS, GDELT, Google News RSS, optional public
    Bluesky authors, optional opinion RSS feeds
  - Each source's success or failure is recorded per snapshot, so a dead source
    is visible instead of silently shrinking the sample
  - Backs off on GDELT 429 rather than retrying into the limit
  - Cache and stale-cache fallback
- `sentiment-analyzer.js`
  - Local rule-based analysis by default, optional local Ollama provider
  - Fixed output schema validation
- `market-sentiment.js`
  - Separates official reporting from opinion sources, applying a reduced weight
    to opinion sources
- `sentiment-status.js`
  - `npm run sentiment:status` — which sources answered, and how old the sample is
- `market-signal.js`
  - Combines macro, sentiment, trend, and MACD scores
  - Decays sentiment by snapshot age (6h half-life, dropped past 24h) so a reused
    cache cannot keep flipping the target allocation
  - Maps the combined score to a target allocation **continuously**, interpolating
    between the RISK_OFF / NEUTRAL / RISK_ON tables instead of stepping at ±1.5
  - Scales equity exposure down when realized volatility exceeds the target

Layer weights are set by `.env` (`MACRO_SCORE_WEIGHT`, `SENTIMENT_SCORE_WEIGHT`,
`TREND_SCORE_WEIGHT`, `MACD_SCORE_WEIGHT`). The weights currently in production
are recorded in `STRATEGY.md`, not here — they change as layers are judged.

### `src/market/`

Owns market-time and price-signal utilities.

- `us-market-session.js`
  - Uses `America/New_York`, handles daylight saving automatically
  - Allows regular-session execution on weekdays from 09:30 to 16:00 ET
- `market-check.js`
  - Diagnoses exchange-rate and ETF price responses
- `signals-check.js`
  - Read-only CLI verifying daily-close collection, trend, and MACD
  - Uses a temp directory so the live cache and PAPER ledger stay untouched
- `macd-signal.js`
  - Calculates 12/26/9 MACD from cached daily closes (34+ required)
  - Also keeps a 15-minute price snapshot, for diagnostics only
  - Produces a bounded score and confidence value
- `trend-signal.js`
  - Faber (2007) moving-average trend filter
  - Fetches daily closes: Twelve Data (key) → Yahoo Finance → Stooq
  - Both keyless sources are blocked from the Oracle host (Stooq serves a
    JavaScript bot wall; Yahoo rate-limits the IP with 429), so
    `TWELVE_DATA_API_KEY` is required in practice
  - Caches to `trend-snapshot.json`, refreshed at most once per ~20 hours
  - Scores price vs the 200-day average with `tanh`, aggregated across symbols

### `src/paper/`

Owns the virtual wallet and trading rules.

- `trading-budget.js`
  - Hard-caps initial capital at KRW 100,000
  - Converts the budget to USD without exceeding the KRW cap
  - Applies maximum and minimum order amounts
- `trading-policy.js`
  - Loads and validates PAPER risk settings; rejects invalid rates and limits
- `exit-strategy.js`
  - Catastrophe stop loss (12% by default)
  - Trailing-profit exit and maximum holding period — **disabled by default**,
    opt-in via `.env`; they are individual-stock momentum rules that fought the
    target-allocation layer on broad index ETFs (see `STRATEGY.md`)
  - Protection of positions not opened by the agent
- `paper-engine.js`
  - Updates positions and cash; evaluates exits before new purchases
  - Enforces daily and total loss brakes on new purchases
  - Applies target-allocation buys inside a no-trade band
  - Credits defensive-sale proceeds to `redeployableUsd` so returning to target
    is as fast as leaving it; daily/per-order caps then throttle only new capital
  - Merges same-cycle buys of one symbol into a single fill
  - Applies minimum order size and re-entry cooldown
  - Tracks **two** fixed benchmarks: 100% VTI buy-and-hold, and the NEUTRAL
    anchor mix (VTI 70 / SCHD 20 / cash 10) held without rebalancing. The second
    is risk-matched, so the gap against it is the signal layers' own result.
    Both are fixed at inception and never react to what the strategy does
- `paper-runner.js`
  - Main scheduled execution entry point
  - **Refuses to run in any non-PAPER mode**
  - Checks the US regular session; prevents overlapping runs with a lock file
  - Loads data sources in parallel; writes state via temp file plus rename
- `paper-status.js` / `events-cli.js`
  - `npm run paper:status` prints current state; `npm run paper:events` the log
- `event-log.js`
  - Append-only JSONL of every cycle: decisions, fills, equity, benchmark
  - Also stores each signal layer's value **before** weights are applied, plus
    the weights themselves and the prices at that instant. Contributions alone
    (raw × confidence × weight × freshness) cannot be un-multiplied later
- `signal-history.js` / `signal-history-cli.js`
  - Rebuilds the news-sentiment series from that log, one row per collection
    snapshot rather than per cycle (news is cached for `NEWS_CACHE_MINUTES`, so
    counting cycles would inflate the sample and force autocorrelation toward 1)
  - Reports mean, spread, mean absolute day-over-day change, sign flips, and
    lag-1 autocorrelation
  - A **"does the value move at all"** gate runs before autocorrelation: a series
    that barely moves cannot be judged by its autocorrelation
  - `npm run paper:signals` prints the table; `--json --daily` exports the series
- `alpha-attribution.js` / `alpha-cli.js`
  - Splits alpha into a **designed** cost and a **defect**, per cycle:
    `(target equity weight − 1) × benchmark return` is the price of deliberately
    holding cash; `(actual − target) × benchmark return` is failing to reach the
    target. The first is a risk decision, the second is a bug
  - Weights are taken at the **start** of each interval, so a large mid-interval
    sale lands in the residual rather than the shortfall
  - Reports the sum-vs-actual gap as `compoundingUsd` instead of hiding it
  - `npm run paper:alpha` prints the split, a verdict, and the worst days

### `src/backtest/`

Owns historical evaluation. Parameter changes are decided here, not in live
PAPER runs — 20 trading days at USD 67 cannot separate a path-dependent rule's
effect from noise.

- `backtest-engine.js`
  - Replays daily closes through the **production** engine and signal functions
    (`buildTrendSignal`, `buildDailyMacdSignal`, `combineMarketSignals`,
    `runPaperCycle`)
  - Takes the macro score as a constant by default; pass `macroScores` (a
    per-day series built by `macro-history.js` from FRED vintages) to also test
    whether that layer times anything. A `null` day falls back to the constant
  - Omits news sentiment. Prices, trend, MACD and the FRED series can all be
    re-fetched at any time; **the news sentiment window cannot**, which is why
    `src/paper/signal-history.js` accumulates it from live runs
  - Accepts a fixed `staticAllocation` to run a signal-free control group
  - Reports CAGR, volatility, Sharpe, max drawdown (strategy and benchmark),
    average exposure, turnover, alpha
- `macro-history.js`
  - Reconstructs what the macro layer **could have known on a past date**
  - FRED returns *revised* values by default. Querying 2008 unemployment today
    returns a final figure nobody had at the time; feeding that to a backtest is
    look-ahead, and it hides itself because the results look good
  - Filters by `realtimeStart` (the date a value became public), which also
    handles release lag without maintaining a per-series release calendar
  - Revision-free series (e.g. `T10Y2Y`) use the observation date instead:
    their vintage history only goes back ~12 years, so `realtimeStart` would
    blank out everything before 2014
- `macro-cache.js`
  - Caches FRED vintage history (`macro-vintages.json`), fetched over a wide
    realtime range. Split from the daily-close cache because revisions grow far
    more slowly than prices
  - Absorbs the 2000-vintage-dates-per-request limit by paging
- `synthetic-prices.js`: deterministic seeded GBM paths with drift/vol/autocorrelation
- `scenarios.js`: bull / bear / choppy / momentum regime scripts
- `price-cache.js`: fetches and caches real daily closes through the same source chain
- `backtest-cli.js`: variant comparison presets
  (`exit`, `macd`, `band`, `cost`, `trend`, `strategy`)
  - `strategy` compares the signal stack against static allocations run through
    the same engine, costs, and no-trade band — the only way to tell whether the
    signal layers earn their keep

### `src/telegram/`

Owns Telegram communication.

- `telegram-client.js`: sends a Bot API `sendMessage` request
- `telegram-check.js`: sends a connection test
- `telegram-discover.js`: helps identify a chat ID
- `daily-report-format.js`: produces the human-readable report
- `daily-report.js`: sends one report per New York trading date

The report includes total equity, cash and ETF market value, total/realized/
unrealized P&L, market regime and supporting signals, current positions, trades
for the New York trading date, risk-brake status, and an explicit PAPER notice.

## 5. Main Execution Flow

### Scheduled PAPER cycle

```text
systemd timer
    |
    v
paper-runner.js
    |
    +--> Refuse to run unless mode is PAPER
    +--> Check New York regular session
    +--> Acquire process lock
    +--> Fetch Toss exchange rate and ETF prices
    +--> Load cached/fresh FRED macro signal
    +--> Load cached/fresh news sentiment
    +--> Update MACD and trend snapshots
    +--> Combine macro + sentiment + trend + MACD (weights from .env)
    +--> Read or initialize paper-state.json
    +--> Evaluate exits
    +--> Evaluate risk brakes
    +--> Calculate target-allocation trades inside the no-trade band
    +--> Append the cycle to paper-events.jsonl
    +--> Atomically write paper-state.json
    +--> Release process lock
```

### Manual live order (human-initiated only)

```text
npm run live:probe -- --symbol SCHD --amount 2 --confirm
    |
    +--> Check EMERGENCY_STOP file
    +--> Check the amount-order window (09:30-15:00 ET)
    +--> Rebuild order state from live-orders.jsonl
    +--> Halt if anything is unresolved
    +--> Record the quote as a slippage baseline
    +--> Submit ONE order through toss-broker.js
    +--> Classify the outcome (resubmit-safe or never)
    +--> Append every event to live-orders.jsonl
    +--> Reconcile against baseline + realized fills
```

### Daily report

```text
toss-ai-report.timer
    |
    v
daily-report.js
    |
    +--> Read paper-state.json
    +--> Format New York trading-day report
    +--> Send Telegram message
    +--> Record the last reported trading date
```

## 6. systemd Deployment

### PAPER timer

- Service: `toss-ai-paper.service`, Timer: `toss-ai-paper.timer`
- Frequency: approximately every 15 minutes
- Service type: one-shot; runtime user: `ubuntu`
- Writable application path: `data/` only

### Telegram report timer

- Service: `toss-ai-report.service`, Timer: `toss-ai-report.timer`
- Schedule: 16:10 `America/New_York`, Monday through Friday
- Persistent timer: enabled; runtime user: `ubuntu`

There is **no systemd unit for live trading.** Both units invoke Node directly;
updating source files does not require a daemon restart, since the next one-shot
execution reads the new files.

## 7. npm Commands

```text
Diagnostics
  npm run doctor             Toss API connectivity diagnostic
  npm run portfolio          Real-account portfolio output
  npm run analyze            Portfolio concentration analysis
  npm run market:check       Exchange-rate and ETF price diagnostic
  npm run macro:status       FRED macro-regime diagnostic
  npm run sentiment:status   News sources answered, and sample age
  npm run signals:check      Daily closes, trend and MACD (writes to a temp dir)

PAPER
  npm run paper:run          Run one PAPER cycle during market hours
  npm run paper:run -- --force        Run one cycle outside market hours
  npm run paper:status       Print current PAPER state
  npm run paper:events       Print the cycle event log
  npm run paper:signals      Sentiment-series statistics (--json --daily to export)
  npm run paper:alpha        Split alpha into designed cost and defect

Live (human-initiated)
  npm run live:probe         Check the live connection — NO order without --confirm
  npm run live:probe -- --symbol SCHD --amount 2 --confirm
  npm run live:baseline      Record the holdings baseline once (check-only without --confirm)
  npm run live:slippage      Realized slippage from the order ledger
  npm run stop               Engage the emergency stop (data/EMERGENCY_STOP)

Backtest
  npm run backtest           Compare exit-rule variants on synthetic scenarios
  npm run backtest -- --compare macd|band|cost|trend|strategy
  npm run backtest:fetch     Cache real daily closes
  npm run backtest:fetch-macro        Cache FRED vintage history
  npm run backtest -- --source cache  Backtest on the cached real data

Telegram
  npm run telegram:discover  Discover Telegram chat information
  npm run telegram:test      Send a Telegram connection test
  npm run telegram:report    Send the scheduled daily report
  npm run telegram:report -- --force  Force a duplicate-date report

Tests
  npm test                   Full suite, summary output
  npm run test:verbose       Full suite, per-test output
```

## 8. Security Boundaries

- Secrets are loaded from `.env`; they must not be committed or logged.
- Toss requires the Oracle server's public outbound IP to be allow-listed.
- **The scheduled runner refuses any non-PAPER mode.** No timer can place an order.
- Live orders require a human running `live:probe` with an explicit `--confirm`;
  the default with no flag places nothing.
- `live:probe` caps the amount it will spend per order.
- `data/EMERGENCY_STOP` halts order submission from the next cycle without a
  service restart.
- The order ledger is append-only and never rewritten.
- Unknown broker order statuses stop and require human review rather than being
  mapped to a guess.
- Real Toss positions and PAPER positions are separate ledgers; reconciliation
  is against the recorded baseline plus our own fills, never the whole account.
- Positions not marked `openedByAgent` are protected from automatic exits.
- systemd restricts filesystem writes to `data/`.

## 9. Verification Status

```text
Test files: 29
Tests:      348
Passed:     348
Failed:     0
```

Verified on the Ubuntu production host, 2026-08-08. Re-run with:

```text
npm test
```

The suite covers API clients, time handling, macro scoring and vintage-based
history reconstruction, news collection and source-failure handling, sentiment
analysis and snapshot freshness, MACD, trend, continuous allocation mapping,
PAPER trading, rebalance-band ratcheting, redeployment symmetry, risk brakes,
exits, the backtester (determinism and look-ahead safety), the broker contract
against both the fake and the Toss adapter, order lifecycle and outcome
classification, live-cycle safety halts, slippage measurement, reporting, and
portfolio analysis.
