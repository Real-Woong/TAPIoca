import test from "node:test";
import assert from "node:assert/strict";

import { createPaperState, runPaperCycle } from "../src/paper/paper-engine.js";
import { createUsdBudget } from "../src/paper/trading-budget.js";
import { loadTradingPolicy } from "../src/paper/trading-policy.js";

// 기존 테스트는 정확한 체결 수량을 단언하므로 거래비용을 0으로 두고, 비용은 별도 테스트에서 검증합니다.
const policy = loadTradingPolicy({ MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0" });
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
  // 첫날 AAA $5 + BBB $5, 둘째 날 AAA $10 한 건입니다. 같은 사이클의 $5×2는
  // 한 건으로 합쳐집니다. 쪼갠 주문은 실익이 없고 건당 최소수수료만 늘립니다.
  const buys = second.state.trades.filter((trade) => trade.side === "BUY");
  assert.equal(buys.length, 3);
  assert.equal(buys.at(-1).amountUsd, 10);
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

test("거래비용을 반영하면 체결 수량이 줄고 누적 수수료가 쌓인다", () => {
  const costPolicy = loadTradingPolicy({
    MAX_ORDER_USD: "5",
    MAX_DAILY_BUY_USD: "10",
    TRADE_COST_RATE: "0.01",
  });
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });

  const result = runPaperCycle(
    state,
    [{ symbol: "AAA", lastPrice: 100 }],
    costPolicy,
    new Date("2026-07-14T00:00:00Z"),
    macroSignal("NEUTRAL"),
  );

  // 하루 $10 매수, 수수료율 1% → 누적 수수료 약 $0.10
  assert.ok(Math.abs(result.summary.feesUsd - 0.1) < 0.001);
  // 가격이 그대로여도 비용만큼 즉시 미실현손실이 생긴다.
  assert.ok(result.summary.positions[0].unrealizedPnlUsd < 0);
  // 모든 매수 체결에 수수료가 기록된다.
  assert.ok(result.state.trades.every((trade) => trade.side !== "BUY" || trade.feeUsd > 0));
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
    TRADE_COST_RATE: "0",
    // 기본 손절선은 재난 방어용 12%이므로, 쿨다운 검증에는 좁은 손절선을 명시합니다.
    STOP_LOSS_RATE: "0.03",
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

test("누적 손실 한도에 도달하면 경고만 남기고 매매는 계속한다", () => {
  const lossPolicy = loadTradingPolicy({
    MAX_ORDER_USD: "5",
    MAX_DAILY_BUY_USD: "10",
    MAX_TOTAL_LOSS_USD: "0.2",
    MAX_DAILY_LOSS_USD: "100",
    STOP_LOSS_RATE: "1",
    TRADE_COST_RATE: "0",
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

  // 손실 한도는 경고일 뿐 매매를 멈추지 않는다. 자동 중단은 폭락 중에 위험관리를
  // 꺼버려 실데이터 20년에서 MDD를 29.8% → 51.6%로 키웠다.
  assert.equal(result.state.risk.lastCheck.alert, true);
  assert.equal(result.state.risk.lastCheck.reason, "TOTAL_LOSS_LIMIT");
  assert.ok(result.decisions.some((item) => item.action === "RISK_ALERT"));
  assert.ok(result.state.trades.length >= tradeCount);
});

test("일일 손실 한도에 도달하면 경고만 남기고 매매는 계속한다", () => {
  const lossPolicy = loadTradingPolicy({
    MAX_ORDER_USD: "5",
    MAX_DAILY_BUY_USD: "10",
    MAX_TOTAL_LOSS_USD: "100",
    MAX_DAILY_LOSS_USD: "0.2",
    STOP_LOSS_RATE: "1",
    TRADE_COST_RATE: "0",
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

  assert.equal(result.state.risk.lastCheck.alert, true);
  assert.equal(result.state.risk.lastCheck.reason, "DAILY_LOSS_LIMIT");
  assert.ok(result.decisions.some((item) => item.action === "RISK_ALERT"));
});

// ── 회전율 억제 ────────────────────────────────────────────────
// 07-28 실제 보고서에서 관측된 패턴을 재현합니다:
// BUY $5 → BUY $5 → SELL $10.01이 같은 날 같은 종목에서 일어났습니다.

function churnState() {
  return createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA", "BBB", "CCC"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
}

test("레짐이 확정 횟수만큼 유지되기 전에는 목표 비중을 바꾸지 않는다", () => {
  const confirming = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0",
    REGIME_CONFIRM_CYCLES: "4",
  });
  const state = churnState();

  runPaperCycle(state, prices, confirming, new Date("2026-07-14T14:00:00Z"), macroSignal("NEUTRAL"));
  assert.equal(state.macro.regime, "NEUTRAL");

  // 장중에 RISK_OFF가 한 번 스쳐도 비중은 NEUTRAL을 유지합니다.
  for (const [index, minute] of [15, 30, 45].entries()) {
    runPaperCycle(
      state, prices, confirming,
      new Date(`2026-07-14T14:${minute}:00Z`),
      macroSignal("RISK_OFF"),
    );
    assert.equal(state.macro.regime, "NEUTRAL", `${index + 1}번째 사이클`);
    assert.equal(state.macro.pendingRegime, "RISK_OFF");
    assert.equal(state.macro.targetAllocation.CASH, 0.1);
  }

  // 4회 연속으로 유지되면 그때 전환합니다.
  runPaperCycle(state, prices, confirming, new Date("2026-07-14T15:00:00Z"), macroSignal("RISK_OFF"));
  assert.equal(state.macro.regime, "RISK_OFF");
  assert.equal(state.macro.targetAllocation.CASH, 0.4);
});

test("레짐이 확정되면 대기 횟수와 무관하게 즉시 방어 비중을 적용한다", () => {
  const immediate = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0",
    REGIME_CONFIRM_CYCLES: "1",
  });
  const state = churnState();

  runPaperCycle(state, prices, immediate, new Date("2026-07-14T14:00:00Z"), macroSignal("NEUTRAL"));
  runPaperCycle(state, prices, immediate, new Date("2026-07-14T14:15:00Z"), macroSignal("RISK_OFF"));

  assert.equal(state.macro.regime, "RISK_OFF");
  assert.equal(state.macro.targetAllocation.CASH, 0.4);
});

test("레짐이 그대로면 하루 한 번만 리밸런싱 매도한다", () => {
  const capped = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0",
    REGIME_CONFIRM_CYCLES: "1", MAX_REBALANCES_PER_DAY: "1",
  });
  const overweight = (state) => {
    state.positions.AAA = {
      symbol: "AAA", openedByAgent: true, quantity: 0.6, entryPrice: 100, peakPrice: 100,
      lastPrice: 100, lastPriceAt: "2026-07-14T00:00:00Z", costUsd: 60,
      openedAt: "2026-07-14T00:00:00Z",
    };
    state.cashUsd = 7.05;
  };
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });

  overweight(state);
  runPaperCycle(state, [{ symbol: "AAA", lastPrice: 100 }], capped,
    new Date("2026-07-14T14:00:00Z"), macroSignal("RISK_OFF"));
  const afterFirst = countRebalanceSells(state);
  assert.equal(afterFirst, 1);
  assert.equal(state.rebalanceLog.count, 1);

  // 같은 날 같은 레짐에서 다시 초과 상태가 돼도 추가로 팔지 않습니다.
  overweight(state);
  runPaperCycle(state, [{ symbol: "AAA", lastPrice: 100 }], capped,
    new Date("2026-07-14T14:15:00Z"), macroSignal("RISK_OFF"));
  assert.equal(countRebalanceSells(state), afterFirst);

  // 날짜가 바뀌면 다시 허용합니다.
  overweight(state);
  runPaperCycle(state, [{ symbol: "AAA", lastPrice: 100 }], capped,
    new Date("2026-07-15T14:00:00Z"), macroSignal("RISK_OFF"));
  assert.equal(countRebalanceSells(state), afterFirst + 1);
});

function countRebalanceSells(state) {
  return state.trades.filter((trade) => trade.reason?.includes("REBALANCE_SELL")).length;
}

// 목표에 거의 도달한 종목을 15분마다 조금씩 더 사면, 그 매수가 다음 리밸런싱 매도를
// 불러 같은 날 왕복매매가 됩니다. 밴드는 그 시작점을 막습니다.
function nearTargetState() {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const equity = state.cashUsd;
  state.positions.AAA = {
    symbol: "AAA", openedByAgent: true, quantity: (equity * 0.67) / 100, entryPrice: 100,
    peakPrice: 100, lastPrice: 100, lastPriceAt: "2026-07-14T00:00:00Z",
    costUsd: equity * 0.67, openedAt: "2026-07-14T00:00:00Z",
  };
  state.cashUsd = equity * 0.33;
  return state;
}

// ── 매수·매도 속도 대칭 ────────────────────────────────────────
// 07-29~08-04 실제 손실 시나리오를 재현합니다. 방어 매도는 1사이클에 전량,
// 재진입은 하루 $10씩이라 4거래일이 걸렸고 그 사이 벤치마크가 +4% 올랐습니다.
// alpha가 +$1.34에서 -$1.60으로 무너진 원인이 이 비대칭입니다.

function fullyInvested(weight) {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const equity = state.cashUsd;
  state.positions.AAA = {
    symbol: "AAA", openedByAgent: true, quantity: (equity * weight) / 100, entryPrice: 100,
    peakPrice: 100, lastPrice: 100, lastPriceAt: "2026-07-14T00:00:00Z",
    costUsd: equity * weight, openedAt: "2026-07-14T00:00:00Z",
  };
  state.cashUsd = equity * (1 - weight);
  return state;
}

test("방어 매도로 빠진 현금은 일일 한도와 무관하게 한 사이클에 목표까지 복귀한다", () => {
  const symmetric = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0",
    REGIME_CONFIRM_CYCLES: "1",
  });
  const state = fullyInvested(0.7);
  const equity = state.funding.fundedUsd;

  // RISK_OFF: AAA 목표 40%로 내려가며 초과분을 한 번에 매도합니다.
  runPaperCycle(state, [{ symbol: "AAA", lastPrice: 100 }], symmetric,
    new Date("2026-07-14T14:00:00Z"), macroSignal("RISK_OFF"));
  const soldUsd = state.trades.at(-1).amountUsd;
  assert.equal(state.trades.at(-1).side, "SELL");
  assert.ok(state.redeployableUsd > 0);
  assert.ok(Math.abs(state.redeployableUsd - soldUsd) < 0.01);

  // NEUTRAL 복귀: 매도액이 하루 한도($10)의 두 배여도 같은 사이클에 되돌아갑니다.
  const back = runPaperCycle(state, [{ symbol: "AAA", lastPrice: 100 }], symmetric,
    new Date("2026-07-15T14:00:00Z"), macroSignal("NEUTRAL"));

  assert.ok(soldUsd > symmetric.maxDailyBuyUsd, "매도액이 일일 한도보다 커야 의미 있는 검증입니다");
  const buy = back.state.trades.at(-1);
  assert.equal(buy.side, "BUY");
  assert.ok(Math.abs(buy.amountUsd - soldUsd) < 0.05, `재진입액 ${buy.amountUsd}`);
  assert.ok(Math.abs(back.summary.positions[0].marketValueUsd - equity * 0.7) < 0.05);
  // 재투입분은 일일 한도를 소진하지 않습니다. 한도는 신규 투입만 제한합니다.
  assert.equal(back.state.dailyBuyUsd["2026-07-15"], 0);
  // 센트 절사로 1센트 미만이 남을 수 있습니다. 최소 주문($1) 아래라 다음 주문을 열지 못합니다.
  assert.ok(back.state.redeployableUsd < 0.05);
});

test("판 적 없는 신규 투입은 여전히 일일 한도를 지킨다", () => {
  const symmetric = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0",
    REGIME_CONFIRM_CYCLES: "1",
  });
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });

  const result = runPaperCycle(state, [{ symbol: "AAA", lastPrice: 100 }], symmetric,
    new Date("2026-07-14T14:00:00Z"), macroSignal("NEUTRAL"));

  assert.equal(result.state.redeployableUsd, 0);
  assert.equal(result.state.dailyBuyUsd["2026-07-14"], 10);
});

test("같은 사이클의 동일 종목 매수는 체결 한 건으로 합쳐진다", () => {
  const fragmented = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "20", TRADE_COST_RATE: "0.001",
    REGIME_CONFIRM_CYCLES: "1",
  });
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });

  const result = runPaperCycle(state, [{ symbol: "AAA", lastPrice: 100 }], fragmented,
    new Date("2026-07-14T14:00:00Z"), macroSignal("NEUTRAL"));

  // 예전에는 $5·$5·$5·$5로 4건이 쌓였습니다.
  const buys = result.state.trades.filter((trade) => trade.side === "BUY");
  assert.equal(buys.length, 1);
  assert.equal(buys[0].amountUsd, 20);
  assert.ok(Math.abs(buys[0].quantity - result.state.positions.AAA.quantity) < 1e-9);
  assert.ok(Math.abs(buys[0].feeUsd - result.summary.feesUsd) < 1e-9);
  // 결정 로그도 종목당 한 줄이어야 리포트가 부풀지 않습니다.
  assert.equal(result.decisions.filter((item) => item.action === "BUY").length, 1);
});

test("목표에서 밴드 이내로만 벗어난 종목은 매수하지 않는다", () => {
  const banded = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0",
    REBALANCE_BAND_RATE: "0.05",
  });

  const result = runPaperCycle(
    nearTargetState(), [{ symbol: "AAA", lastPrice: 100 }], banded,
    new Date("2026-07-14T14:00:00Z"), macroSignal("NEUTRAL"),
  );

  // 목표 70% 대비 67%로 3%p 부족하지만 밴드(5%) 안이므로 주문을 내지 않습니다.
  assert.equal(result.state.trades.length, 0);
  assert.equal(result.state.dailyBuyUsd["2026-07-14"], 0);
});

test("밴드를 넘어서면 예전처럼 목표까지 매수한다", () => {
  const looseBand = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0",
    REBALANCE_BAND_RATE: "0.001",
  });

  const result = runPaperCycle(
    nearTargetState(), [{ symbol: "AAA", lastPrice: 100 }], looseBand,
    new Date("2026-07-14T14:00:00Z"), macroSignal("NEUTRAL"),
  );

  assert.ok(result.state.trades.length > 0);
});

// ── 손실 브레이크 ──────────────────────────────────────────────
// 예전에는 브레이크가 매수만 멈추고 리밸런싱 매도는 계속 돌았다. 자산이 현금으로
// 빠지면 회복될 수 없어 브레이크가 영원히 풀리지 않았고, 2008년급 하락을 심은
// 백테스트에서 자산이 17년간 한 값에 동결됐다.

function brakedState(policyEnv = {}) {
  const braking = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0",
    REGIME_CONFIRM_CYCLES: "1", MAX_TOTAL_LOSS_USD: "2", MAX_DAILY_LOSS_USD: "100",
    ...policyEnv,
  });
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const equity = state.cashUsd;
  state.positions.AAA = {
    symbol: "AAA", openedByAgent: true, quantity: equity / 100, entryPrice: 100,
    peakPrice: 100, lastPrice: 100, lastPriceAt: "2026-07-14T00:00:00Z",
    costUsd: equity, openedAt: "2026-07-14T00:00:00Z",
  };
  state.cashUsd = 0;
  return { state, braking };
}

test("손실 한도에 닿아도 목표 비중 리밸런싱을 계속한다", () => {
  const { state, braking } = brakedState();

  // -5% 하락으로 누적 손실 한도($2)를 넘긴다. RISK_OFF 목표는 40%이므로
  // 초과분을 덜어내야 한다. 예전에는 여기서 모든 매매가 멈췄다.
  const result = runPaperCycle(state, [{ symbol: "AAA", lastPrice: 95 }], braking,
    new Date("2026-07-15T14:00:00Z"), macroSignal("RISK_OFF"));

  assert.equal(result.state.risk.lastCheck.alert, true);
  assert.ok(result.decisions.some((item) => item.action === "RISK_ALERT"));
  // 위험관리(익스포저 축소)는 계속 돌아야 한다. 한도에 닿았다고 멈추면
  // 폭락 구간에서 방어를 포기하는 셈이 된다.
  assert.equal(result.state.trades.at(-1).side, "SELL");
  assert.ok(result.state.trades.at(-1).reason.includes("REBALANCE_SELL"));
});

test("손실 한도에 닿아도 손절은 평소대로 발동한다", () => {
  const { state, braking } = brakedState({ STOP_LOSS_RATE: "0.05" });

  const result = runPaperCycle(state, [{ symbol: "AAA", lastPrice: 90 }], braking,
    new Date("2026-07-15T14:00:00Z"), macroSignal("RISK_OFF"));

  assert.equal(result.state.risk.lastCheck.alert, true);
  assert.equal(result.state.trades.at(-1).reason, "STOP_LOSS");
  assert.equal(result.state.positions.AAA, undefined);
});

test("손실이 회복되면 경고가 스스로 사라진다", () => {
  const { state, braking } = brakedState();

  runPaperCycle(state, [{ symbol: "AAA", lastPrice: 95 }], braking,
    new Date("2026-07-15T14:00:00Z"), macroSignal("NEUTRAL"));
  assert.equal(state.risk.lastCheck.alert, true);

  const recovered = runPaperCycle(state, [{ symbol: "AAA", lastPrice: 110 }], braking,
    new Date("2026-07-16T14:00:00Z"), macroSignal("NEUTRAL"));

  assert.equal(recovered.state.risk.lastCheck.alert, false);
  assert.ok(!recovered.decisions.some((item) => item.action === "RISK_ALERT"));
});

test("브레이크가 없으면 손절은 평소대로 발동한다", () => {
  const normal = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0",
    REGIME_CONFIRM_CYCLES: "1", MAX_TOTAL_LOSS_USD: "100", MAX_DAILY_LOSS_USD: "100",
    STOP_LOSS_RATE: "0.05",
  });
  const { state } = brakedState();

  const result = runPaperCycle(state, [{ symbol: "AAA", lastPrice: 90 }], normal,
    new Date("2026-07-15T14:00:00Z"), macroSignal("RISK_OFF"));

  assert.equal(result.state.trades.at(-1).reason, "STOP_LOSS");
  assert.equal(result.state.positions.AAA, undefined);
});

// VTI 100%와만 비교하면 "현금을 들고 있어서 뒤처진 것"과 "타이밍이 틀려서 뒤처진 것"이
// 한 숫자에 섞인다. 방어 중일 때 alpha를 면제해 주면 벤치마크가 우리 행동을 따라
// 움직여 방어가 틀렸을 때를 못 보게 되므로, 대신 미리 정해진 기준선을 하나 더 둔다.
test("같은 비중을 신호 없이 들고 있었을 때를 두 번째 기준선으로 잰다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA", "BBB", "CCC"],
    now: new Date("2026-07-14T00:00:00Z"),
  });

  const result = runPaperCycle(
    state, prices, policy, new Date("2026-07-14T00:00:00Z"), macroSignal("NEUTRAL"),
  );
  const summary = result.summary;

  // 기준선은 NEUTRAL 앵커(VTI·SCHD)를 쓰는데 이 워치리스트에는 그 가격이 없다.
  // 한 종목이라도 빠진 채 개설하면 비중이 틀어진 기준선이 영구히 고정되므로 미룬다.
  assert.equal(result.state.policyBenchmark, undefined);
  assert.equal(summary.policyBenchmark, null);
  assert.equal(summary.policyAlphaUsd, null);
  // 반면 VTI 100% 벤치마크는 워치리스트 첫 종목으로 대체해 계속 잰다.
  assert.ok(summary.benchmark);
});

// 2026-08-27: 기준선은 지갑보다 나중에 열린다. 개설 시점의 지갑 자산을 남겨 두지
// 않으면, 나중에 초과성과를 낼 때 **기준선이 열리기 전 구간의 손익까지** 함께
// 빼게 된다. 운영 상태에서는 그 구간이 20일이었고 그 안에 구축 램프가 통째로 들어 있었다.
test("기준선을 열 때 그 시점의 지갑 자산을 함께 남긴다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["VTI", "SCHD"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const marketPrices = [
    { symbol: "VTI", lastPrice: 100 },
    { symbol: "SCHD", lastPrice: 50 },
  ];

  const first = runPaperCycle(
    state, marketPrices, policy, new Date("2026-07-14T00:00:00Z"), macroSignal("NEUTRAL"),
  );
  const funded = first.state.funding.fundedUsd;

  // 첫 사이클이라 개설 시점의 지갑은 아직 전액 현금이다.
  assert.equal(first.state.benchmark.walletEquityUsdAtStart, funded);
  assert.equal(first.state.policyBenchmark.walletEquityUsdAtStart, funded);
  assert.equal(first.summary.alphaWindow.anchorEquityUsd, roundTo(funded));
  assert.equal(first.summary.alphaWindow.anchorSource, "OPEN");

  // 같은 날 열렸으므로 이 시점의 초과성과는 예전 방식(누적손익 − 기준선손익)과 같다.
  assert.equal(
    first.summary.alphaUsd,
    roundTo(first.summary.totalPnlUsd - first.summary.benchmark.pnlUsd),
  );

  // 지갑이 움직여도 기준선의 기준점은 개설 시점 그대로여야 한다.
  const second = runPaperCycle(
    first.state,
    [{ symbol: "VTI", lastPrice: 110 }, { symbol: "SCHD", lastPrice: 55 }],
    policy,
    new Date("2026-07-15T00:00:00Z"),
    macroSignal("NEUTRAL"),
  );
  assert.equal(second.state.benchmark.walletEquityUsdAtStart, funded);
  assert.equal(
    second.summary.alphaUsd,
    roundTo((second.summary.equityUsd - funded) - second.summary.benchmark.pnlUsd),
  );
});

test("정책믹스 기준선은 진입 비용을 부담하고 현금 몫을 그대로 남긴다", () => {
  // 공유 policy는 수량 단언을 위해 비용 0이므로, 비용 부담은 여기서 따로 켠다.
  const costPolicy = loadTradingPolicy({
    MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10", TRADE_COST_RATE: "0.001",
  });
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["VTI", "SCHD"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const marketPrices = [
    { symbol: "VTI", lastPrice: 100 },
    { symbol: "SCHD", lastPrice: 50 },
  ];

  const first = runPaperCycle(
    state, marketPrices, costPolicy, new Date("2026-07-14T00:00:00Z"), macroSignal("NEUTRAL"),
  );
  const benchmark = first.state.policyBenchmark;
  const funded = first.state.funding.fundedUsd;

  // 현금 10%는 주식으로 바꾸지 않고 그대로 둔다.
  assert.equal(benchmark.cashUsd, roundTo(funded * 0.1));
  // 수량 = 배분액 × (1 − 비용) / 가격
  assert.ok(Math.abs(benchmark.positions.VTI.quantity - (funded * 0.7 * 0.999) / 100) < 1e-9);
  assert.ok(Math.abs(benchmark.positions.SCHD.quantity - (funded * 0.2 * 0.999) / 50) < 1e-9);
  // 개설 직후에는 비용만큼만 손실이다.
  assert.ok(Math.abs(first.summary.policyBenchmark.pnlUsd + funded * 0.9 * 0.001) < 0.02);

  // 주식이 10% 오르면 기준선도 주식 몫만큼만 오른다(현금 10%는 그대로).
  const second = runPaperCycle(
    first.state,
    [{ symbol: "VTI", lastPrice: 110 }, { symbol: "SCHD", lastPrice: 55 }],
    costPolicy,
    new Date("2026-07-15T00:00:00Z"),
    macroSignal("NEUTRAL"),
  );
  const expected = funded * 0.9 * 0.999 * 1.1 + funded * 0.1;
  assert.ok(
    Math.abs(second.summary.policyBenchmark.valueUsd - expected) < 0.02,
    `${second.summary.policyBenchmark.valueUsd} vs ${expected}`,
  );
});

// 기준선이 우리 행동을 따라 움직이면 방어가 틀렸을 때를 영영 못 본다.
// 신호가 무엇을 하든 이 기준선은 개설 시점 그대로여야 한다.
test("정책믹스 기준선은 레짐이 바뀌어도 재조정되지 않는다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["VTI", "SCHD"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  const marketPrices = [
    { symbol: "VTI", lastPrice: 100 },
    { symbol: "SCHD", lastPrice: 50 },
  ];

  let current = runPaperCycle(
    state, marketPrices, policy, new Date("2026-07-14T00:00:00Z"), macroSignal("NEUTRAL"),
  ).state;
  const opened = { ...current.policyBenchmark.positions.VTI };

  for (const [index, regime] of ["RISK_OFF", "RISK_OFF", "RISK_ON"].entries()) {
    current = runPaperCycle(
      current, marketPrices, policy,
      new Date(`2026-07-${16 + index}T00:00:00Z`), macroSignal(regime),
    ).state;
  }

  assert.equal(current.policyBenchmark.positions.VTI.quantity, opened.quantity);
  assert.deepEqual(current.policyBenchmark.mix, { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 });
});

// LIVE에서도 PAPER 장부는 돈다. 이것이 안 돌면 9/1처럼 첫 사이클이 통째로
// 죽고, 실주문 이전에 결정 자체가 안 나온다.
test("LIVE 정책으로도 PAPER 장부는 그대로 돈다", () => {
  const livePolicy = loadTradingPolicy({
    LIVE_TRADING: "true",
    MAX_ORDER_USD: "5",
    MAX_DAILY_BUY_USD: "10",
    TRADE_COST_RATE: "0",
  });
  assert.equal(livePolicy.mode, "LIVE");

  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA", "BBB", "CCC"],
    now: new Date("2026-07-14T00:00:00Z"),
  });

  const result = runPaperCycle(state, prices, livePolicy, new Date("2026-07-14T00:00:00Z"));

  assert.equal(result.state.mode, "PAPER");
  assert.equal(result.state.dailyBuyUsd["2026-07-14"], 10);
  assert.ok(result.decisions.length > 0);
});

// 반대쪽 방어선. 실계좌 장부를 넘기면 멈춰야 한다.
test("PAPER가 아닌 장부는 거부한다", () => {
  const state = createPaperState({
    budget: createUsdBudget("1491.8"),
    watchlist: ["AAA"],
    now: new Date("2026-07-14T00:00:00Z"),
  });
  state.mode = "LIVE";

  assert.throws(
    () => runPaperCycle(state, prices, policy, new Date("2026-07-14T00:00:00Z")),
    /PAPER 장부에서만/,
  );
});

function roundTo(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
