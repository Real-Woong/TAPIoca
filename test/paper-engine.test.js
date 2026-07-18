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
