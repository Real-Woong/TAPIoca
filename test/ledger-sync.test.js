import test from "node:test";
import assert from "node:assert/strict";

import { planLedgerSync, SELL_FRACTION } from "../src/live/ledger-sync.js";
import { buildOrders } from "../src/live/order-lifecycle.js";

const LIMITS = { minOrderUsd: 1, maxOrderUsd: 6.7, maxDailyBuyUsd: 13.4 };
const NOW = new Date("2026-09-17T15:00:00Z");
const MANAGED = ["VTI", "SCHD", "IWM"];

let sequence = 0;
/** 원장 이벤트로 주문 하나를 만듭니다. `state`가 없으면 전량 체결입니다. */
function order({ symbol, side = "BUY", usd, price = 100, at = NOW.toISOString(), state = "FILLED" }) {
  sequence += 1;
  const clientOrderId = `T-${sequence}`;
  const events = [{ type: "PLANNED", clientOrderId, at, symbol, side, requestedUsd: usd }];
  if (state === "FILLED") {
    events.push({ type: "FILL", clientOrderId, filledUsd: usd, filledQuantity: usd / price, terminal: true });
  } else if (state === "REJECTED") {
    events.push({ type: "REJECTED", clientOrderId, at, reason: "insufficient-buying-power" });
  } else if (state === "SUBMITTED") {
    events.push({ type: "SUBMITTED", clientOrderId, at, brokerOrderId: `B-${sequence}` });
  }
  return events;
}

function plan({ ledger = {}, events = [], prices = { VTI: 100, SCHD: 100, IWM: 100 }, ...rest } = {}) {
  return planLedgerSync({
    ledgerPositions: ledger,
    orders: buildOrders(events.flat()),
    prices: new Map(Object.entries(prices)),
    managedSymbols: MANAGED,
    limits: LIMITS,
    now: NOW,
    ...rest,
  });
}

// 2026-09-16 아침 보고서 그대로입니다. 장부는 07-14에 다 채웠고 실계좌에는
// 8월 probe 잔해만 있었습니다. 결정만 옮기던 시절에는 여기서 주문이 0건이었습니다.
test("9/16 계좌: 장부만큼 채우는 주문이 나온다 — 매도 먼저, 매수는 한도 안에서", () => {
  const prices = { VTI: 371.6, SCHD: 33.8, IWM: 283.6 };
  const events = [
    order({ symbol: "VTI", usd: 1.95, price: prices.VTI, at: "2026-08-28T14:00:00Z" }),
    order({ symbol: "SCHD", usd: 16.08, price: prices.SCHD, at: "2026-08-07T14:00:00Z" }),
    order({ symbol: "IWM", usd: 1.89, price: prices.IWM, at: "2026-08-28T14:05:00Z" }),
  ];
  const ledger = { VTI: 46.18 / prices.VTI, SCHD: 13.6 / prices.SCHD, IWM: 4.9 / prices.IWM };

  const { intents } = plan({ ledger, events, prices, maxLiveValueUsd: 66.18 });

  assert.deepEqual(intents, [
    { symbol: "SCHD", side: "SELL", amountUsd: 2.48 },
    { symbol: "VTI", side: "BUY", amountUsd: 6.7 },
    { symbol: "IWM", side: "BUY", amountUsd: 3.01 },
  ]);
});

// 같은 수량을 들고 있으면 가격은 두 쪽을 똑같이 움직인다. 가격 변동이 주문을
// 만들면 15분마다 잔챙이 매매가 돌아온다.
test("수량이 같으면 가격이 움직여도 주문이 없다", () => {
  const events = [order({ symbol: "VTI", usd: 40, price: 100, at: "2026-09-10T14:00:00Z" })];
  const { intents } = plan({ ledger: { VTI: 0.4 }, events, prices: { VTI: 130 } });
  assert.deepEqual(intents, []);
});

test("$1 미만 차이는 내지 않는다", () => {
  const events = [order({ symbol: "VTI", usd: 40, at: "2026-09-10T14:00:00Z" })];
  const { intents } = plan({ ledger: { VTI: 0.409 }, events });
  assert.deepEqual(intents, []);
});

// 금액 매도는 제출과 체결 사이 가격이 오르면 보유보다 많이 팔려고 해 거절된다.
test("전량 매도는 보유의 98%까지만 낸다", () => {
  const events = [order({ symbol: "IWM", usd: 10, at: "2026-09-10T14:00:00Z" })];
  const { intents } = plan({ ledger: {}, events });
  assert.deepEqual(intents, [{ symbol: "IWM", side: "SELL", amountUsd: 10 * SELL_FRACTION }]);
});

test("매도는 1회 한도에 안 걸린다 — 위험을 줄이는 쪽이다", () => {
  const events = [order({ symbol: "VTI", usd: 40, at: "2026-09-10T14:00:00Z" })];
  const { intents } = plan({ ledger: { VTI: 0.1 }, events });
  assert.deepEqual(intents, [{ symbol: "VTI", side: "SELL", amountUsd: 30 }]);
});

test("하루 매수 한도를 실계좌 원장으로 센다", () => {
  const events = [
    order({ symbol: "VTI", usd: 6.7 }),
    order({ symbol: "VTI", usd: 6.5 }),
  ];
  const { intents, notes } = plan({ ledger: { VTI: 0.5 }, events });
  assert.deepEqual(intents, [], "남은 $0.20은 최소 주문 미만이다");
  assert.match(notes.join(" "), /매수 한도/);
});

// 진행 중인 매수를 0으로 세면 체결을 기다리는 사이 한도를 넘겨 낸다.
test("체결 전 매수는 요청액으로 한도에 잡힌다", () => {
  const events = [order({ symbol: "VTI", usd: 6.7, state: "SUBMITTED" }), order({ symbol: "VTI", usd: 6.7 })];
  const { intents } = plan({ ledger: { VTI: 0.5 }, events });
  assert.deepEqual(intents, []);
});

test("어제 산 것은 오늘 한도에 안 잡힌다", () => {
  const events = [order({ symbol: "VTI", usd: 13.4, at: "2026-09-16T15:00:00Z" })];
  const { intents } = plan({ ledger: { VTI: 0.5 }, events });
  assert.deepEqual(intents, [{ symbol: "VTI", side: "BUY", amountUsd: 6.7 }]);
});

// 장부의 redeployableUsd와 같은 규칙이다. 리밸런싱으로 판 돈을 사는 데 하루 한도를
// 또 쓰면 실계좌만 며칠씩 현금으로 남는다.
test("오늘 판 금액만큼은 다시 살 수 있다", () => {
  const events = [
    order({ symbol: "SCHD", usd: 10, at: "2026-09-10T14:00:00Z" }),
    order({ symbol: "VTI", usd: 13.4 }),
    order({ symbol: "SCHD", side: "SELL", usd: 5 }),
  ];
  const { intents } = plan({ ledger: { VTI: 0.2, SCHD: 0.05 }, events });
  // VTI 보유 $13.4, 장부 $20 → 차이 $6.6, 여력은 판 $5
  assert.deepEqual(intents, [{ symbol: "VTI", side: "BUY", amountUsd: 5 }]);
});

// 매수 여력 부족 같은 거절은 15분 뒤에도 그대로다. 막지 않으면 하루 26번 거절이 쌓인다.
test("오늘 거절된 종목·방향은 오늘 다시 내지 않는다", () => {
  const events = [order({ symbol: "VTI", usd: 6.7, state: "REJECTED" })];
  const { intents, notes } = plan({ ledger: { VTI: 0.3, IWM: 0.03 }, events });
  assert.deepEqual(intents, [{ symbol: "IWM", side: "BUY", amountUsd: 3 }]);
  assert.match(notes.join(" "), /VTI BUY: 오늘 거절/);
});

test("실계좌 평가액은 장부 자산을 넘지 않는다", () => {
  const { intents } = plan({ ledger: { VTI: 0.5 }, maxLiveValueUsd: 4 });
  assert.deepEqual(intents, [{ symbol: "VTI", side: "BUY", amountUsd: 4 }]);
});

test("가격이 없는 종목은 맞추지 않고 이유를 남긴다", () => {
  const { intents, notes } = plan({ ledger: { VTI: 0.5 }, prices: {} });
  assert.deepEqual(intents, []);
  assert.match(notes.join(" "), /VTI: 가격이 없어/);
});
