import test from "node:test";
import assert from "node:assert/strict";

import { evaluateExit, stopThreshold } from "../src/paper/exit-strategy.js";
import { loadTradingPolicy } from "../src/paper/trading-policy.js";

const policy = loadTradingPolicy({});
// 지수 ETF 기본값에서는 꺼져 있는 규칙들입니다. 개별 종목 매매용으로 켤 때의
// 동작을 검증하기 위해 명시적으로 활성화한 정책을 따로 둡니다.
const momentumPolicy = loadTradingPolicy({
  STOP_LOSS_RATE: "0.03",
  TRAILING_ACTIVATION_RATE: "0.025",
  TRAILING_DRAWDOWN_RATE: "0.015",
  MAX_HOLDING_DAYS: "15",
});
const now = new Date("2026-07-14T00:00:00Z");

function position(overrides = {}) {
  return {
    symbol: "TEST",
    openedByAgent: true,
    entryPrice: 100,
    peakPrice: 100,
    openedAt: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

test("기존 보유분은 어떤 가격에서도 매도하지 않는다", () => {
  const result = evaluateExit(position({ openedByAgent: false }), 50, policy, now);
  assert.deepEqual(result, { action: "HOLD", reason: "PROTECTED_EXISTING_POSITION" });
});

test("재난 방어 손절선에 도달하면 손절 신호를 낸다", () => {
  const result = evaluateExit(position(), 87.9, policy, now);
  assert.equal(result.action, "SELL");
  assert.equal(result.reason, "STOP_LOSS");
});

// 지수 ETF의 일변동은 약 0.95%입니다. 예전 기본값(3%)은 노이즈에 그대로 걸려
// 목표 비중 레이어가 "70% 보유"라고 말하는 동안 포지션을 비웠습니다.
test("지수 ETF 기본값에서는 3% 하락으로 손절하지 않는다", () => {
  const result = evaluateExit(position(), 97, policy, now);
  assert.equal(result.action, "HOLD");
  assert.equal(result.reason, "NO_EXIT_SIGNAL");
});

test("트레일링 익절은 기본값에서 꺼져 있다", () => {
  const result = evaluateExit(position({ peakPrice: 104 }), 102.4, policy, now);
  assert.equal(result.action, "HOLD");
});

test("최대 보유기간 청산은 기본값에서 꺼져 있다", () => {
  const result = evaluateExit(position({ openedAt: "2026-06-20T00:00:00Z" }), 101, policy, now);
  assert.equal(result.action, "HOLD");
});

test("명시적으로 켜면 수익 구간 진입 후 고점에서 밀릴 때 수익 실현 신호를 낸다", () => {
  const result = evaluateExit(position({ peakPrice: 104 }), 102.4, momentumPolicy, now);
  assert.equal(result.action, "SELL");
  assert.equal(result.reason, "TRAILING_PROFIT");
  assert.ok(result.returnRate > 0);
});

test("명시적으로 켜면 최대 보유기간을 넘길 때 시간 청산 신호를 낸다", () => {
  const result = evaluateExit(
    position({ openedAt: "2026-06-20T00:00:00Z" }),
    101,
    momentumPolicy,
    now,
  );
  assert.equal(result.action, "SELL");
  assert.equal(result.reason, "MAX_HOLDING_PERIOD");
});

test("off를 지정하면 켜져 있던 규칙도 비활성으로 돌아간다", () => {
  const disabled = loadTradingPolicy({ MAX_HOLDING_DAYS: "off" });
  assert.equal(disabled.maxHoldingDays, null);
  const result = evaluateExit(position({ openedAt: "2026-06-20T00:00:00Z" }), 101, disabled, now);
  assert.equal(result.action, "HOLD");
});

test("청산 조건이 없으면 보유하고 새로운 고점을 기록한다", () => {
  const result = evaluateExit(position(), 101, policy, now);
  assert.equal(result.action, "HOLD");
  assert.equal(result.peakPrice, 101);
});

// Kaminski & Lo(2014)는 손절 문턱을 표준편차 배수로 잡는다. 고정 비율은 변동성에
// 반비례해 잘못 스케일되어, 폭락장에서 가장 쉽게 발동한다.
test("변동성 배수를 설정하면 손절 문턱이 그때의 변동성을 따라간다", () => {
  const sigmaPolicy = loadTradingPolicy({ STOP_LOSS_SIGMA: "0.85" });

  // 평시(연율 14%)에는 0.85 × 0.14 = 11.9%로 지금의 12%와 사실상 같다.
  assert.ok(Math.abs(stopThreshold(sigmaPolicy, 0.14) - 0.119) < 1e-9);
  // 폭락장(연율 40%)에서는 34%로 넓어져 일상적 등락에 발동하지 않는다.
  assert.ok(Math.abs(stopThreshold(sigmaPolicy, 0.4) - 0.34) < 1e-9);
  // 고정 비율은 같은 두 국면에서 12%로 똑같다. 이것이 문제의 핵심이다.
  assert.equal(stopThreshold(loadTradingPolicy({}), 0.14), 0.12);
  assert.equal(stopThreshold(loadTradingPolicy({}), 0.4), 0.12);
});

// 변동성을 모르는 사이클에 문턱이 0이 되면 전 포지션이 즉시 청산된다.
test("변동성을 알 수 없으면 고정 비율로 되돌아간다", () => {
  const policy = loadTradingPolicy({ STOP_LOSS_SIGMA: "0.85", STOP_LOSS_RATE: "0.12" });

  for (const vol of [undefined, null, NaN, 0, -0.2]) {
    assert.equal(stopThreshold(policy, vol), 0.12, `변동성 ${vol}`);
  }
});

test("변동성 배수를 쓰면 같은 하락이 국면에 따라 다르게 판정된다", () => {
  const policy = loadTradingPolicy({ STOP_LOSS_SIGMA: "0.85" });
  const position = {
    openedByAgent: true, quantity: 1, entryPrice: 100, peakPrice: 100,
    openedAt: "2026-08-01T00:00:00Z", costUsd: 100,
  };
  const now = new Date("2026-08-05T00:00:00Z");

  // -20% 하락: 평시(문턱 11.9%)에는 손절, 폭락장(문턱 34%)에는 보유.
  assert.equal(evaluateExit(position, 80, policy, now, 0.14).action, "SELL");
  assert.equal(evaluateExit(position, 80, policy, now, 0.4).action, "HOLD");
});

test("변동성 배수를 설정하지 않으면 기존 동작이 그대로다", () => {
  const policy = loadTradingPolicy({});
  const position = {
    openedByAgent: true, quantity: 1, entryPrice: 100, peakPrice: 100,
    openedAt: "2026-08-01T00:00:00Z", costUsd: 100,
  };
  const now = new Date("2026-08-05T00:00:00Z");

  // 변동성을 넘겨도 무시하고 고정 12%로 판단한다.
  assert.equal(evaluateExit(position, 80, policy, now, 0.4).action, "SELL");
  assert.equal(evaluateExit(position, 90, policy, now, 0.4).action, "HOLD");
});
