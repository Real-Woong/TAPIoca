# TAPIoca File Structure

> Architecture snapshot for external review  
> Last updated: 2026-08-05

## 1. Project Summary

TAPIoca is a read-only Toss Securities integration and PAPER trading experiment.
It reads account and market data, evaluates market conditions, updates a
file-based virtual portfolio, and sends a daily Telegram report.

The current system does **not** implement or call a live order API.

## 2. Runtime Overview

- Runtime: Node.js 20.12 or newer
- Module system: JavaScript ES Modules
- Third-party runtime dependencies: none
- Test framework: Node.js built-in test runner
- Production host: Oracle Cloud Linux instance
- Scheduler: systemd services and timers
- Persistent storage: local JSON files under `data/`
- Primary user interface: Telegram daily reports

## 3. Repository Tree

```text
toss-ai-agent/
├── README.md
├── file_structure.md
├── trading_method.md
├── STRATEGY_REVIEW_2026-08-05.md   # PAPER 9영업일 사후분석 + 개선 로드맵
├── package.json
├── deploy/
│   ├── toss-ai-paper.service
│   ├── toss-ai-paper.timer
│   ├── toss-ai-report.service
│   └── toss-ai-report.timer
├── src/
│   ├── backtest/
│   │   ├── backtest-cli.js
│   │   ├── backtest-engine.js
│   │   ├── price-cache.js
│   │   ├── scenarios.js
│   │   └── synthetic-prices.js
│   ├── toss/
│   │   ├── doctor.js
│   │   └── toss-client.js
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
│   └── telegram/
│       ├── daily-report-format.js
│       ├── daily-report.js
│       ├── telegram-check.js
│       ├── telegram-client.js
│       └── telegram-discover.js
└── test/
    ├── backtest-engine.test.js
    ├── daily-report.test.js
    ├── event-log.test.js
    ├── exit-strategy.test.js
    ├── fred-client.test.js
    ├── free-news-fetcher.test.js
    ├── macd-signal.test.js
    ├── macro-regime.test.js
    ├── macro-snapshot.test.js
    ├── market-sentiment.test.js
    ├── market-signal.test.js
    ├── paper-engine.test.js
    ├── portfolio-analysis.test.js
    ├── sentiment-analyzer.test.js
    ├── signal-history.test.js
    ├── telegram-client.test.js
    ├── toss-client.test.js
    ├── trading-budget.test.js
    ├── trading-policy.test.js
    ├── trend-signal.test.js
    └── us-market-session.test.js
```

Generated runtime files are intentionally not included in the source tree above:

```text
data/
├── paper-state.json
├── telegram-report-state.json
├── macro-snapshot.json
├── free-news-cache.json
├── macd-snapshot.json
├── paper-events.jsonl
├── trend-snapshot.json
├── backtest-closes.json
└── paper-runner.lock
```

## 4. Module Responsibilities

### `src/toss/`

Owns Toss Securities API communication.

- `toss-client.js`
  - OAuth2 token acquisition and in-process token reuse
  - Account discovery
  - Portfolio retrieval
  - ETF price retrieval
  - USD/KRW exchange-rate retrieval
  - Toss error normalization
- `doctor.js`
  - Read-only connection diagnostic
  - Verifies credentials, allowed public IP, and account visibility

### `src/portfolio/`

Owns read-only analysis of the real Toss account.

- Retrieves domestic and US positions
- Separates currencies instead of incorrectly summing KRW and USD
- Calculates position weights and HHI concentration
- Warns about excessive single-position concentration
- Does not modify the PAPER portfolio

### `src/FRED_data/`

Owns macroeconomic data collection and regime classification.

- `fred-client.js`: downloads FRED observations
- `macro-regime.js`: converts macro observations into a score and regime
- `macro-snapshot.js`: caches the latest usable macro result
- `macro-status.js`: command-line diagnostic

The regime is one of:

```text
RISK_ON
NEUTRAL
RISK_OFF
```

### `src/sentiment/`

Owns free news collection and sentiment analysis.

- `free-news-fetcher.js`
  - Federal Reserve RSS
  - GDELT economic news
  - Optional public Bluesky authors
  - Optional opinion RSS feeds
  - Cache and stale-cache fallback
- `sentiment-analyzer.js`
  - Local rule-based analysis by default
  - Optional local Ollama provider
  - Fixed output schema validation
- `market-sentiment.js`
  - Separates official reporting from opinion sources
  - Applies a reduced weight to opinion sources
- `market-signal.js`
  - Combines FRED, sentiment, trend, and MACD scores
  - Decays sentiment by snapshot age (6h half-life, dropped past 24h) so a reused
    cache cannot keep flipping the target allocation
  - Maps the combined score to a target allocation **continuously**, interpolating
    between the RISK_OFF / NEUTRAL / RISK_ON tables instead of stepping at ±1.5
  - Scales equity exposure down when realized volatility exceeds the target

### `src/market/`

Owns market-time and price-signal utilities.

- `us-market-session.js`
  - Uses `America/New_York`
  - Handles daylight saving time automatically
  - Allows regular-session execution on weekdays from 09:30 to 16:00 ET
- `market-check.js`
  - Diagnoses exchange-rate and ETF price responses
- `signals-check.js`
  - Read-only CLI: verifies daily-close collection, trend, and MACD
  - Uses a temp directory so the live cache and PAPER ledger stay untouched
  - `npm run signals:check`

- `macd-signal.js`
  - Stores one price snapshot per 15-minute bucket
  - Calculates 12/26/9 MACD from the cached daily closes (34+ required)
  - Also keeps the 15-minute price snapshot, for diagnostics only
  - Produces a bounded score and confidence value
- `trend-signal.js`
  - Faber (2007) moving-average trend filter
  - Fetches daily closes: Twelve Data (key) -> Yahoo Finance -> Stooq
  - As of 2026-08-03 both keyless sources are blocked from the Oracle host
    (Stooq serves a JavaScript bot wall; Yahoo rate-limits the IP with 429),
    so TWELVE_DATA_API_KEY is required in practice
  - Caches to `trend-snapshot.json`, refreshed at most once per ~20 hours
  - Scores price vs the 200-day average with `tanh`, aggregated across symbols

Note: MACD moved from 15-minute snapshots to daily closes on 2026-08-03.
Historical note — the old limitation was that MACD used scheduled snapshots, not official OHLCV
candles. The trend layer and MACD both use official daily closes.

### `src/paper/`

Owns the virtual wallet and trading rules.

- `trading-budget.js`
  - Hard-caps initial capital at KRW 100,000
  - Converts the budget to USD without exceeding the KRW cap
  - Applies maximum and minimum order amounts
- `trading-policy.js`
  - Loads validated PAPER risk settings
  - Rejects invalid rates and limits
- `exit-strategy.js`
  - Catastrophe stop loss (12% by default)
  - Trailing-profit exit and maximum holding period — **disabled by default**,
    opt-in via `.env`; they are individual-stock momentum rules that fought the
    target-allocation layer on broad index ETFs (see `STRATEGY_REVIEW_2026-08-05.md`)
  - Protection of positions not opened by the agent
- `paper-engine.js`
  - Updates positions and cash
  - Evaluates exits before new purchases
  - Enforces daily and total loss brakes on new purchases
  - Applies target-allocation buys
  - Credits defensive-sale proceeds to `redeployableUsd` so returning to target
    is as fast as leaving it; daily/per-order caps then throttle only new capital
  - Merges same-cycle buys of one symbol into a single fill
  - Applies minimum order size and re-entry cooldown
  - Records trades and risk state
- `paper-runner.js`
  - Main scheduled execution entry point
  - Checks the US regular session
  - Prevents overlapping runs with a lock file
  - Loads data sources in parallel
  - Writes state using temporary-file plus rename
- `paper-status.js`
  - Prints the current PAPER state without placing trades
- `event-log.js`
  - Append-only JSONL of every cycle: decisions, fills, equity, benchmark
  - Also stores each signal layer's value **before** weights are applied, plus the
    weights themselves and the prices at that instant. Contributions alone
    (raw × confidence × weight × freshness) cannot be un-multiplied later
- `signal-history.js`
  - Rebuilds the news-sentiment series from that log, one row per collection
    snapshot rather than per cycle (news is cached for `NEWS_CACHE_MINUTES`, so
    counting cycles would inflate the sample and force autocorrelation toward 1)
  - Reports mean, spread, mean absolute day-over-day change, sign flips, and
    lag-1 autocorrelation — the statistic that decides whether the layer carries
    information or is indistinguishable from a fresh draw each day
- `signal-history-cli.js`
  - `npm run paper:signals` prints that table; `--json --daily` exports the
    series for backtesting

### `src/backtest/`

Owns historical evaluation. Parameter changes are decided here, not in live PAPER
runs — 20 trading days at USD 67 cannot separate a path-dependent rule's effect
from noise.

- `backtest-engine.js`
  - Replays daily closes through the **production** engine and signal functions
    (`buildTrendSignal`, `buildDailyMacdSignal`, `combineMarketSignals`, `runPaperCycle`)
  - Holds the FRED score constant and omits news sentiment. Prices, trend, MACD
    and the FRED series can all be re-fetched at any time; **the news sentiment
    window cannot**, which is why `src/paper/signal-history.js` accumulates it
    from live runs — that log is the only path to ever backtesting this layer
  - Accepts a fixed `staticAllocation` to run a signal-free control group
  - Reports CAGR, volatility, Sharpe, max drawdown (strategy and benchmark),
    average exposure, turnover, alpha
- `synthetic-prices.js`: deterministic seeded GBM paths with drift/vol/autocorrelation
- `scenarios.js`: bull / bear / choppy / momentum regime scripts
- `price-cache.js`: fetches and caches real daily closes through the same source chain
- `backtest-cli.js`: variant comparison presets (`exit`, `macd`, `band`, `cost`, `trend`, `strategy`)
  - `strategy` compares the signal stack against static allocations run through the
    same engine, costs, and no-trade band — the only way to tell whether the signal
    layers earn their keep

### `src/telegram/`

Owns Telegram communication.

- `telegram-client.js`: sends a Bot API `sendMessage` request
- `telegram-check.js`: sends a connection test
- `telegram-discover.js`: helps identify a chat ID
- `daily-report-format.js`: produces the human-readable report
- `daily-report.js`: sends one report per New York trading date

The report includes:

- Total equity
- Cash and ETF market value
- Total, realized, and unrealized P&L
- Market regime and supporting signals
- Current positions
- Trades for the New York trading date
- Risk-brake status
- Explicit PAPER-mode notice

## 5. Main Execution Flow

```text
systemd timer
    |
    v
paper-runner.js
    |
    +--> Check New York regular session
    +--> Acquire process lock
    +--> Fetch Toss exchange rate and ETF prices
    +--> Load cached/fresh FRED macro signal
    +--> Load cached/fresh news sentiment
    +--> Update MACD price snapshots
    +--> Combine FRED + sentiment + MACD
    +--> Read or initialize paper-state.json
    +--> Evaluate exits
    +--> Evaluate risk brakes
    +--> Calculate target-allocation purchases
    +--> Atomically write paper-state.json
    +--> Release process lock
```

Daily reporting is separate:

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

- Service: `toss-ai-paper.service`
- Timer: `toss-ai-paper.timer`
- Frequency: approximately every 15 minutes
- Service type: one-shot
- Runtime user: `ubuntu`
- Writable application path: `data/` only

### Telegram report timer

- Service: `toss-ai-report.service`
- Timer: `toss-ai-report.timer`
- Schedule: 16:10 `America/New_York`, Monday through Friday
- Persistent timer: enabled
- Runtime user: `ubuntu`

Both services invoke Node directly. Updating source files does not require a
daemon restart; the next one-shot execution reads the new files.

## 7. npm Commands

```text
npm run doctor             Toss API connectivity diagnostic
npm run portfolio          Real-account portfolio output
npm run analyze            Portfolio concentration analysis
npm run market:check       Exchange-rate and ETF price diagnostic
npm run macro:status       FRED macro-regime diagnostic
npm run paper:run          Run one PAPER cycle during market hours
npm run paper:run -- --force
                            Run one PAPER cycle outside market hours
npm run paper:status       Print current PAPER state
npm run backtest           Compare exit-rule variants on synthetic scenarios
npm run backtest -- --compare macd|band|cost|trend|strategy
npm run backtest:fetch     Cache real daily closes (uses .env for the API key)
npm run backtest -- --source cache   Backtest on the cached real data
npm run telegram:discover  Discover Telegram chat information
npm run telegram:test      Send a Telegram connection test
npm run telegram:report    Send the scheduled daily report
npm run telegram:report -- --force
                            Force a duplicate-date report
npm test                   Run the complete test suite
```

## 8. Security Boundaries

- Secrets are loaded from `.env`; they must not be committed or logged.
- Toss requires the Oracle server's public outbound IP to be allow-listed.
- The current runner refuses LIVE mode.
- No live order endpoint is implemented.
- Real Toss positions and PAPER positions are separate.
- Positions not marked `openedByAgent` are protected from automatic exits.
- systemd restricts filesystem writes to `data/`.
- Runtime-generated JSON files use owner-only permissions where created by the
  service.

## 9. Current Verification Status

As of 2026-08-05:

```text
Tests:   147
Passed:  147
Failed:  0
```

The suite covers API clients, time handling, macro scoring, news collection,
sentiment analysis and snapshot freshness, MACD, trend, continuous allocation
mapping, PAPER trading, redeployment symmetry, risk brakes, exits, the
backtester (determinism and look-ahead safety), reporting, and portfolio analysis.

## 10. Repository Cleanup Candidates

All items below were resolved on 2026-08-04. They are kept as a record of what
was removed and why, so the same files are not re-created by mistake.

1. RESOLVED 2026-08-04 — `oracle-python/` was removed. Four of its five files
   were zero bytes; only `requirements.txt` had content, and no JavaScript
   referenced it.
2. RESOLVED 2026-08-04 — `src/MACD/` (empty) and the duplicated
   `src/paper/src/paper/` copies were removed. The stale copies still contained
   the pre-rebalancing engine, which made them actively misleading to read. The
   active MACD implementation is `src/market/macd-signal.js`.
3. RESOLVED — the stray `test/paper-` directory left by an interrupted `rsync`
   no longer exists in the working tree.
4. RESOLVED 2026-08-04 — `src/paper/README.md` was removed. It was a
   byte-identical copy of the root `README.md`, not a paper-specific document.
5. RESOLVED 2026-08-04 — `package.json` now defines `sentiment:status`, so the
   documented command matches the script that exists.

None of these were part of the running strategy. The duplicated engine copy was
the costly one: it held a pre-rebalancing version of `paper-engine.js`, so anyone
reading it saw logic that no longer ran.

## 11. Suggested Architecture Review Questions

External reviewers are invited to evaluate:

1. Is JSON-file state sufficient for the current one-instance PAPER workload?
2. Should risk evaluation and allocation logic be separated into pure modules?
3. Is the lock-file approach robust enough after abnormal process termination?
4. Should state files include schema versions and explicit migrations?
5. Should market data, decisions, and executions be stored as an append-only
   event log instead of only a mutable state snapshot?
6. How should the system model fees, spreads, slippage, and rejected orders?
7. Which components must be redesigned before any approved live-order workflow?

