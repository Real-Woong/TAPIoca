import test from "node:test";
import assert from "node:assert/strict";

import { runBacktest } from "../src/backtest/backtest-engine.js";
import { generateMarket, generatePath } from "../src/backtest/synthetic-prices.js";
import { buildScenario, SCENARIOS } from "../src/backtest/scenarios.js";
import { loadTradingPolicy } from "../src/paper/trading-policy.js";

// 일봉 백테스트에서는 사이클 하나가 하루이므로 레짐 확정도 사이클 단위로 지정합니다.
const policy = loadTradingPolicy({
  MAX_ORDER_USD: "5",
  MAX_DAILY_BUY_USD: "10",
  TRADE_COST_RATE: "0.001",
  REGIME_CONFIRM_CYCLES: "1",
});

function market(seed = 7, days = 400) {
  return generateMarket(seed, ["VTI", "SCHD"], { days });
}

test("같은 시드는 같은 경로를 만든다", () => {
  assert.deepEqual(generatePath(11, { days: 50 }), generatePath(11, { days: 50 }));
  assert.notDeepEqual(generatePath(11, { days: 50 }), generatePath(12, { days: 50 }));
});

test("백테스트 결과는 결정론적이다", () => {
  const closes = market();
  const first = runBacktest({ closesBySymbol: closes, policy });
  const second = runBacktest({ closesBySymbol: closes, policy });
  assert.deepEqual(first.metrics, second.metrics);
});

// 백테스터에서 가장 흔하고 가장 치명적인 버그입니다. 미래 종가가 과거 판단에
// 새어 들어가면 성과가 부풀고, 그 백테스트는 아무것도 보장하지 못합니다.
test("미래 종가를 바꿔도 그 이전 거래는 달라지지 않는다", () => {
  const closes = market();
  const cutoff = 300;
  const tampered = Object.fromEntries(
    Object.entries(closes).map(([symbol, series]) => [
      symbol,
      series.map((close, index) => (index >= cutoff ? close * 3 : close)),
    ]),
  );

  const original = runBacktest({ closesBySymbol: closes, policy });
  const modified = runBacktest({ closesBySymbol: tampered, policy });

  const before = (result) =>
    result.state.trades
      .filter((trade) => trade.executedAt < result.equityCurve[cutoff - 201].date + "T99")
      .map((trade) => `${trade.side}:${trade.symbol}:${trade.amountUsd}`);

  // 양쪽이 모두 비어 있으면 비교가 무의미하므로 실제 거래가 있었는지 먼저 확인합니다.
  assert.ok(before(original).length > 0, "비교할 거래가 없습니다");
  assert.deepEqual(before(original), before(modified));
  // 반대로 이후 구간은 달라져야 합니다(테스트가 아무것도 안 재는 상태를 방지).
  assert.notDeepEqual(original.metrics, modified.metrics);
});

test("워밍업 기간 동안은 매매하지 않는다", () => {
  const closes = market(7, 260);
  const result = runBacktest({ closesBySymbol: closes, policy, warmupDays: 250 });
  // 250일 워밍업 뒤 10거래일만 남으므로 자산 곡선도 10개입니다.
  assert.equal(result.equityCurve.length, 10);
  assert.ok(result.state.trades.every((trade) => trade.executedAt >= result.equityCurve[0].date));
});

test("일봉이 워밍업보다 짧으면 조용히 빈 결과를 내지 않고 중단한다", () => {
  assert.throws(
    () => runBacktest({ closesBySymbol: market(7, 100), policy }),
    /일봉이 부족합니다/,
  );
});

test("지표가 정의된 범위 안에 있다", () => {
  const { metrics } = runBacktest({ closesBySymbol: market(3, 800), policy });
  assert.ok(metrics.maxDrawdownPct >= 0 && metrics.maxDrawdownPct <= 100);
  assert.ok(metrics.averageExposurePct >= 0 && metrics.averageExposurePct <= 100);
  assert.ok(metrics.annualVolPct >= 0);
  assert.ok(metrics.turnoverPerYear >= 0);
  assert.equal(metrics.benchmarkSymbol, "VTI");
  assert.ok(Number.isFinite(metrics.alphaPct));
});

test("모든 시나리오가 백테스트를 통과한다", () => {
  for (const name of Object.keys(SCENARIOS)) {
    const closes = buildScenario(name, { seed: 5, days: 500, symbols: ["VTI", "SCHD"] });
    const { metrics } = runBacktest({ closesBySymbol: closes, policy });
    assert.ok(Number.isFinite(metrics.cagrPct), `${name} CAGR`);
  }
});

test("알 수 없는 시나리오는 이름을 알려주며 실패한다", () => {
  assert.throws(
    () => buildScenario("nope", { seed: 1, days: 300, symbols: ["VTI"] }),
    /알 수 없는 시나리오/,
  );
});

// P0에서 바꾼 기본값이 실제로 회전율을 줄이는지 백테스트로 확인합니다.
// 20일치 PAPER 운용으로는 이 차이를 우연과 구분할 수 없었습니다.
test("이전 청산 규칙은 회전율을 몇 배로 키운다", () => {
  const closes = market(21, 900);
  const legacy = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0.001",
    REGIME_CONFIRM_CYCLES: "1",
    STOP_LOSS_RATE: "0.03", TRAILING_ACTIVATION_RATE: "0.025",
    TRAILING_DRAWDOWN_RATE: "0.015", MAX_HOLDING_DAYS: "15",
  });

  const current = runBacktest({ closesBySymbol: closes, policy }).metrics;
  const previous = runBacktest({ closesBySymbol: closes, policy: legacy }).metrics;

  assert.ok(
    previous.turnoverPerYear > current.turnoverPerYear * 3,
    `이전 ${previous.turnoverPerYear} vs 현재 ${current.turnoverPerYear}`,
  );
  assert.ok(previous.tradeCount > current.tradeCount * 2);
});
