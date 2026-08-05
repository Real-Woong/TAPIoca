import test from "node:test";
import assert from "node:assert/strict";

import { loadTradingPolicy } from "../src/paper/trading-policy.js";

test("지수 ETF 기본값은 개별 종목용 청산 규칙을 켜지 않는다", () => {
  const policy = loadTradingPolicy({});
  assert.equal(policy.stopLossRate, 0.12);
  assert.equal(policy.trailingActivationRate, null);
  assert.equal(policy.trailingDrawdownRate, null);
  assert.equal(policy.maxHoldingDays, null);
});

test("청산 규칙은 값을 지정하면 켜지고 off로 다시 꺼진다", () => {
  const on = loadTradingPolicy({ MAX_HOLDING_DAYS: "15", TRAILING_DRAWDOWN_RATE: "0.015" });
  assert.equal(on.maxHoldingDays, 15);
  assert.equal(on.trailingDrawdownRate, 0.015);

  const off = loadTradingPolicy({ MAX_HOLDING_DAYS: "off", TRAILING_DRAWDOWN_RATE: "none" });
  assert.equal(off.maxHoldingDays, null);
  assert.equal(off.trailingDrawdownRate, null);
});

// 예전 기본값은 4사이클(=1시간)이었습니다. 월간 FRED 데이터로 만든 레짐에
// 1시간 확정은 사실상 무방비였습니다.
test("레짐 확정 기간을 거래일로 적으면 사이클 수로 환산한다", () => {
  assert.equal(loadTradingPolicy({}).regimeConfirmCycles, 26);
  assert.equal(loadTradingPolicy({ REGIME_CONFIRM_DAYS: "2" }).regimeConfirmCycles, 52);
  assert.equal(loadTradingPolicy({ REGIME_CONFIRM_DAYS: "0.5" }).regimeConfirmCycles, 13);
});

test("사이클 수를 직접 지정하면 거래일 환산보다 우선한다", () => {
  const policy = loadTradingPolicy({ REGIME_CONFIRM_CYCLES: "1", REGIME_CONFIRM_DAYS: "5" });
  assert.equal(policy.regimeConfirmCycles, 1);
});

test("잘못된 설정값은 조용히 기본값으로 넘어가지 않고 실패한다", () => {
  assert.throws(() => loadTradingPolicy({ MIN_ORDER_USD: "10", MAX_ORDER_USD: "5" }));
  assert.throws(() => loadTradingPolicy({ STOP_LOSS_RATE: "2" }), /0보다 크고 1 이하/);
  assert.throws(() => loadTradingPolicy({ MAX_HOLDING_DAYS: "1.5" }), /정수/);
});
