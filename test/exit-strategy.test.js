import test from "node:test";
import assert from "node:assert/strict";

import { evaluateExit } from "../src/paper/exit-strategy.js";
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
