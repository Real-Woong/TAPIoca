import test from "node:test";
import assert from "node:assert/strict";

import { evaluateExit } from "../src/paper/exit-strategy.js";
import { loadTradingPolicy } from "../src/paper/trading-policy.js";

const policy = loadTradingPolicy({});
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

test("손실 한도에 도달하면 손절 신호를 낸다", () => {
  const result = evaluateExit(position(), 96.9, policy, now);
  assert.equal(result.action, "SELL");
  assert.equal(result.reason, "STOP_LOSS");
});

test("수익 구간 진입 후 고점에서 밀리면 수익 실현 신호를 낸다", () => {
  const result = evaluateExit(position({ peakPrice: 104 }), 102.4, policy, now);
  assert.equal(result.action, "SELL");
  assert.equal(result.reason, "TRAILING_PROFIT");
  assert.ok(result.returnRate > 0);
});

test("최대 보유기간을 넘기면 시간 청산 신호를 낸다", () => {
  const result = evaluateExit(
    position({ openedAt: "2026-06-20T00:00:00Z" }),
    101,
    policy,
    now,
  );
  assert.equal(result.action, "SELL");
  assert.equal(result.reason, "MAX_HOLDING_PERIOD");
});

test("청산 조건이 없으면 보유하고 새로운 고점을 기록한다", () => {
  const result = evaluateExit(position(), 101, policy, now);
  assert.equal(result.action, "HOLD");
  assert.equal(result.peakPrice, 101);
});
