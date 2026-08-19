import test from "node:test";
import assert from "node:assert/strict";

import { BROKER_MIN_USD, toOrderIntents } from "../src/live/paper-bridge.js";

test("BUY·SELL만 주문 의도가 된다", () => {
  const { intents } = toOrderIntents([
    { symbol: "VTI", action: "BUY", reason: "TARGET_WEIGHT", amountUsd: 3.2 },
    { symbol: "IWM", action: "SELL", reason: "EXIT_BAND", amountUsd: 1.5 },
  ]);

  assert.deepEqual(intents, [
    { symbol: "VTI", side: "BUY", amountUsd: 3.2 },
    { symbol: "IWM", side: "SELL", amountUsd: 1.5 },
  ]);
});

// PAPER 결정에는 주문이 아닌 것이 섞여 있다. 그대로 넘기면 `side: "RISK_ALERT"`인
// 주문이 브로커로 간다.
test("알림 결정은 주문으로 옮기지 않는다", () => {
  const { intents, dropped } = toOrderIntents([
    { symbol: "VTI", action: "RISK_ALERT", reason: "MAX_TOTAL_LOSS" },
    { symbol: "SCHD", action: "PAUSE_BUY", reason: "MACRO_UNAVAILABLE" },
    { symbol: "VTI", action: "BUY", amountUsd: 2 },
  ]);

  assert.deepEqual(intents, [{ symbol: "VTI", side: "BUY", amountUsd: 2 }]);
  assert.deepEqual(dropped.map((item) => item.action), ["RISK_ALERT", "PAUSE_BUY"]);
});

// `toss-broker`가 금액을 toFixed(2)로 고정하므로 1센트 미만은 "0.00"이 되어
// $0짜리 주문이 나간다. 호출 한도만 쓰고 거절당한다.
test("브로커 최소 단위 미만은 내지 않는다", () => {
  const { intents, dropped } = toOrderIntents([
    { symbol: "VTI", action: "BUY", amountUsd: 0.004 },
    { symbol: "SCHD", action: "BUY", amountUsd: BROKER_MIN_USD },
  ]);

  assert.deepEqual(intents, [{ symbol: "SCHD", side: "BUY", amountUsd: BROKER_MIN_USD }]);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].why, /최소 단위/);
});

test("금액이 없거나 0 이하면 주문이 되지 않는다", () => {
  const { intents, dropped } = toOrderIntents([
    { symbol: "VTI", action: "BUY" },
    { symbol: "VTI", action: "BUY", amountUsd: null },
    { symbol: "VTI", action: "SELL", amountUsd: 0 },
    { symbol: "VTI", action: "BUY", amountUsd: -1 },
  ]);

  assert.deepEqual(intents, []);
  assert.equal(dropped.length, 4);
});

// **버린 것을 돌려주지 않으면 되짚을 수 없다.** 실행기가 이것을 그대로 출력한다.
test("버린 결정은 이유와 함께 돌려준다", () => {
  const { dropped } = toOrderIntents([
    { symbol: "VTI", action: "RISK_ALERT", reason: "MAX_TOTAL_LOSS" },
  ]);

  assert.equal(dropped[0].symbol, "VTI");
  assert.equal(dropped[0].reason, "MAX_TOTAL_LOSS", "원래 결정을 그대로 실어 보낸다");
  assert.match(dropped[0].why, /주문이 아닌 결정/);
});

test("결정이 없으면 빈 결과를 낸다", () => {
  assert.deepEqual(toOrderIntents(), { intents: [], dropped: [] });
  assert.deepEqual(toOrderIntents([]), { intents: [], dropped: [] });
});
