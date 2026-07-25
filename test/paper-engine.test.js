import test from "node:test";
import assert from "node:assert/strict";

import { createPaperState, runPaperCycle } from "../src/paper/paper-engine.js";
import { createUsdBudget } from "../src/paper/trading-budget.js";
import { loadTradingPolicy } from "../src/paper/trading-policy.js";

const policy = loadTradingPolicy({ MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10" });
const prices = [
  { symbol: "AAA", lastPrice: 100 },
  { symbol: "BBB", lastPrice: 50 },
  { symbol: "CCC", lastPrice: 25 },
];

function macroSignal(regime = "NEUTRAL") {
  const allocations = {
    RISK_ON: { AAA: 0.7, BBB: 0.15, CCC: 0.15, CASH: 0 },
    NEUTRAL: { AAA: 0.7, BBB: 0.2, CCC: 0, CASH: 0.1 },
    RISK_OFF: { AAA: 0.4, BBB: 0.2, CCC: 0, CASH: 0.4 },
  };
  return {
    fetchedAt: "2026-07-14T00:00:00Z",
    evaluatedAt: "2026-07-14T00:00:00Z",
    regime,
    score: 0,
    targetAllocation: allocations[regime],
    indicators: {},
    reasons: ["TEST"],
    source: "TEST",
    stale: false,
  };
}

test("첫 실행은 10만 원 이하의 PAPER 지갑만 만들고 일일 한도만 매수한다", () => {
  const budget = createUsdBudget("1491.8");
  const state = createPaperState({
    budget,
    watchlist: ["AAA", "BBB", "CCC"],
    now: new Date("2026-07-14T00:00:00Z"),
  });

  const result = runPaperCycle(state, prices, policy, new Date("2026-07-14T00:00:00Z"));

  assert.ok(result.state.funding.fundedKrwActual <= 100000);
  assert.equal(result.state.dailyBuyUsd["2026-07-14"], 10);
  assert.equal(Object.keys(result.state.positions).length, 2);
  assert.equal(result.state.trades.filter((trade) => trade.side === "BUY").length, 2);
  assert.equal(result.summary.tradeCount, 2);
});

test("같은 날 다시 실행해도 일일 매수 한도를 넘지 않는다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA", "BBB", "CCC"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  runPaperCycle(state, prices, policy, new Date("2026-07-14T00:00:00Z"));
  const second = runPaperCycle(state, prices, policy, new Date("2026-07-14T01:00:00Z"));

  assert.equal(second.state.dailyBuyUsd["2026-07-14"], 10);
  assert.equal(Object.keys(second.state.positions).length, 2);
});

test("다음 날 남은 ETF를 매수해도 최초 지갑 밖의 돈을 사용하지 않는다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA", "BBB", "CCC"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  runPaperCycle(state, prices, policy, new Date("2026-07-14T00:00:00Z"));
  const second = runPaperCycle(state, prices, policy, new Date("2026-07-15T00:00:00Z"));

  assert.equal(Object.keys(second.state.positions).length, 3);
  assert.ok(second.summary.equityUsd <= state.funding.fundedUsd);
});

test("최근 시장가격을 상태에 보존해 상태 조회에서도 평가손익을 유지한다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  runPaperCycle(state, prices, policy, new Date("2026-07-14T00:00:00Z"));
  const second = runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 101, timestamp: "2026-07-14T01:00:00Z" }],
    policy,
    new Date("2026-07-14T01:00:00Z"),
  );

  assert.equal(second.state.positions.AAA.lastPrice, 101);
  assert.equal(second.summary.positions[0].unrealizedPnlUsd, 0.05);
});

test("거시경제 목표 비중에 없는 ETF는 매수하지 않는다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA", "BBB", "CCC"],
    now: new Date("2026-07-14T00:00:00Z"),
  });

  const result = runPaperCycle(
    state,
    prices,
    policy,
    new Date("2026-07-14T00:00:00Z"),
    macroSignal("NEUTRAL"),
  );

  assert.deepEqual(Object.keys(result.state.positions).sort(), ["AAA", "BBB"]);
  assert.equal(result.state.positions.CCC, undefined);
  assert.equal(result.state.macro.regime, "NEUTRAL");
  assert.equal(result.state.dailyBuyUsd["2026-07-14"], 10);
});

test("다음 거래일에도 목표 비중이 덜 찬 기존 포지션을 추가 매수한다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA", "BBB", "CCC"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const signal = macroSignal("NEUTRAL");
  runPaperCycle(state, prices, policy, new Date("2026-07-14T00:00:00Z"), signal);
  const second = runPaperCycle(
    state,
    prices,
    policy,
    new Date("2026-07-15T00:00:00Z"),
    signal,
  );

  // AAA 목표가 70%, BBB 목표가 20%이므로 둘째 날에는 AAA의 부족 비중을 먼저 채웁니다.
  assert.equal(second.state.positions.AAA.costUsd, 15);
  assert.equal(second.state.positions.BBB.costUsd, 5);
  assert.equal(second.state.trades.filter((trade) => trade.side === "BUY").length, 4);
});

test("목표 비중을 밴드 이상 초과하면 방어적 레짐 전환 시 초과분을 매도한다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  // 전액 AAA를 보유한(익스포저 100%) 목표 초과 상태를 수동으로 만듭니다.
  const equity = state.cashUsd;
  state.positions.AAA = {
    symbol: "AAA",
    openedByAgent: true,
    quantity: equity / 100,
    entryPrice: 100,
    peakPrice: 100,
    lastPrice: 100,
    lastPriceAt: "2026-07-14T00:00:00Z",
    costUsd: equity,
    openedAt: "2026-07-14T00:00:00Z",
  };
  state.cashUsd = 0;

  // RISK_OFF에서 AAA 목표는 40%이므로 초과 60%p를 덜어내야 합니다.
  const result = runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 100 }],
    policy,
    new Date("2026-07-14T02:00:00Z"),
    macroSignal("RISK_OFF"),
  );

  const sell = result.state.trades.at(-1);
  assert.equal(sell.side, "SELL");
  assert.equal(sell.reason, "MACRO_RISK_OFF_REBALANCE_SELL");
  // 매도 후 AAA 평가액은 목표(자산의 40%)에 수렴합니다.
  const aaaValue = result.summary.positions[0].marketValueUsd;
  assert.ok(Math.abs(aaaValue - equity * 0.4) < 0.05);
  assert.ok(result.state.cashUsd > equity * 0.55);
});

test("첫 실행에 벤치마크를 개설하고 이후 초과성과(alpha)를 계산한다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const funded = state.funding.fundedUsd;

  const first = runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 100 }],
    policy,
    new Date("2026-07-14T00:00:00Z"),
    macroSignal("NEUTRAL"),
  );
  // 원금 전액을 AAA에 넣은 매수후보유 기준선이 만들어집니다.
  assert.equal(first.state.benchmark.symbol, "AAA");
  assert.ok(Math.abs(first.state.benchmark.quantity - funded / 100) < 1e-9);
  assert.equal(first.summary.benchmark.pnlUsd, 0);

  // AAA가 10% 오르면 벤치마크는 원금의 약 +10%가 되고, alpha는 전략−벤치마크입니다.
  const second = runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 110 }],
    policy,
    new Date("2026-07-15T00:00:00Z"),
    macroSignal("NEUTRAL"),
  );
  assert.ok(second.summary.benchmark.pnlUsd > funded * 0.09);
  assert.equal(
    second.summary.alphaUsd,
    Math.round((second.summary.totalPnlUsd - second.summary.benchmark.pnlUsd) * 100) / 100,
  );
});

test("거시경제 신호가 null이면 청산 판단은 유지하고 신규 매수만 중단한다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });

  const result = runPaperCycle(
    state,
    prices,
    policy,
    new Date("2026-07-14T00:00:00Z"),
    null,
  );

  assert.equal(Object.keys(result.state.positions).length, 0);
  assert.equal(result.decisions[0].reason, "MACRO_SIGNAL_UNAVAILABLE");
});

test("청산한 종목은 쿨다운 중 재매수하지 않고 만료 후 다시 살 수 있다", () => {
  const cooldownPolicy = loadTradingPolicy({
    MAX_ORDER_USD: "5",
    MAX_DAILY_BUY_USD: "10",
    REENTRY_COOLDOWN_HOURS: "24",
  });
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const signal = macroSignal("NEUTRAL");
  runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 100 }],
    cooldownPolicy,
    new Date("2026-07-14T00:00:00Z"),
    signal,
  );

  const sold = runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 96 }],
    cooldownPolicy,
    new Date("2026-07-15T00:00:00Z"),
    signal,
  );
  assert.equal(sold.state.positions.AAA, undefined);
  assert.equal(sold.state.trades.at(-1).side, "SELL");

  const reentered = runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 96 }],
    cooldownPolicy,
    new Date("2026-07-16T01:00:00Z"),
    signal,
  );
  assert.ok(reentered.state.positions.AAA);
  assert.equal(reentered.state.trades.at(-1).side, "BUY");
});

test("누적 손실 한도에 도달하면 신규 매수를 중단한다", () => {
  const lossPolicy = loadTradingPolicy({
    MAX_ORDER_USD: "5",
    MAX_DAILY_BUY_USD: "10",
    MAX_TOTAL_LOSS_USD: "0.2",
    MAX_DAILY_LOSS_USD: "100",
    STOP_LOSS_RATE: "1",
  });
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const signal = macroSignal("NEUTRAL");
  runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 100 }],
    lossPolicy,
    new Date("2026-07-14T00:00:00Z"),
    signal,
  );
  const tradeCount = state.trades.length;

  const result = runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 95 }],
    lossPolicy,
    new Date("2026-07-15T00:00:00Z"),
    signal,
  );

  assert.equal(result.state.trades.length, tradeCount);
  assert.equal(result.state.risk.lastCheck.buyPaused, true);
  assert.equal(result.decisions.at(-1).reason, "TOTAL_LOSS_LIMIT");
});

test("일일 손실 한도에 도달하면 신규 매수를 중단한다", () => {
  const lossPolicy = loadTradingPolicy({
    MAX_ORDER_USD: "5",
    MAX_DAILY_BUY_USD: "10",
    MAX_TOTAL_LOSS_USD: "100",
    MAX_DAILY_LOSS_USD: "0.2",
    STOP_LOSS_RATE: "1",
  });
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const signal = macroSignal("NEUTRAL");
  runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 100 }],
    lossPolicy,
    new Date("2026-07-14T00:00:00Z"),
    signal,
  );

  const result = runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 95 }],
    lossPolicy,
    new Date("2026-07-15T00:00:00Z"),
    signal,
  );

  assert.equal(result.state.risk.lastCheck.buyPaused, true);
  assert.equal(result.decisions.at(-1).reason, "DAILY_LOSS_LIMIT");
});
