import test from "node:test";
import assert from "node:assert/strict";

import { assertBrokerContract } from "../src/live/broker-contract.js";
import { createFakeBroker } from "../src/live/fake-broker.js";
import {
  ORDER_STATES,
  buildOrders,
  realizedFills,
  reconcile,
  unresolvedOrders,
} from "../src/live/order-lifecycle.js";
import { clientOrderId } from "../src/live/order-store.js";

/**
 * 실주문 안전장치를 고정합니다.
 *
 * 여기서 잡으려는 것은 전략이 아니라 **사고**입니다. 같은 매수를 두 번 하는 것,
 * 절반만 체결된 것을 전량으로 착각하는 것, 브로커와 장부가 어긋난 채 리밸런싱하는
 * 것. 이 셋은 전부 돈을 잃는 방식이고, 백테스트로는 한 번도 볼 수 없습니다.
 */

test("가짜 브로커가 실제 어댑터와 같은 계약을 지킨다", () => {
  // 여기서 통과한 실행 로직이 실거래에서도 같은 모양으로 돌아야 하므로,
  // 가짜와 진짜가 같은 검사를 통과해야 합니다.
  assert.equal(assertBrokerContract(createFakeBroker()), true);
});

test("필수 기능이 빠진 브로커는 이유와 함께 거부한다", () => {
  assert.throws(
    () => assertBrokerContract({ submitOrder: () => {} }),
    /getOrder|listOpenOrders|getPositions|cancelOrder/,
  );
});

test("clientOrderId는 같은 사이클을 재실행해도 같은 값이다", () => {
  // 재시도가 새 주문이 되면 안 됩니다. 이것이 중복 매수를 막는 첫 번째 방벽입니다.
  const args = { cycleAt: "2026-08-07T14:30:00Z", symbol: "VTI", side: "BUY" };
  assert.equal(clientOrderId(args), clientOrderId({ ...args }));
  assert.notEqual(clientOrderId(args), clientOrderId({ ...args, symbol: "IWM" }));
  assert.notEqual(clientOrderId(args), clientOrderId({ ...args, side: "SELL" }));
});

test("부분 체결이 여러 번 오면 더해서 세고, 다 차야 FILLED다", () => {
  const orders = buildOrders([
    { type: "PLANNED", clientOrderId: "A", symbol: "VTI", side: "BUY", requestedUsd: 10 },
    { type: "SUBMITTED", clientOrderId: "A", brokerOrderId: "BRK-1" },
    { type: "FILL", clientOrderId: "A", filledUsd: 4, filledQuantity: 0.04 },
  ]);
  assert.equal(orders.get("A").state, ORDER_STATES.PARTIAL);

  const done = buildOrders([
    { type: "PLANNED", clientOrderId: "A", symbol: "VTI", side: "BUY", requestedUsd: 10 },
    { type: "FILL", clientOrderId: "A", filledUsd: 4, filledQuantity: 0.04 },
    { type: "FILL", clientOrderId: "A", filledUsd: 6, filledQuantity: 0.06 },
  ]);
  assert.equal(done.get("A").state, ORDER_STATES.FILLED);
  assert.equal(done.get("A").filledUsd, 10);
});

test("끝난 주문에 PLANNED가 다시 와도 상태를 되돌리지 않는다", () => {
  // 재시작 후 같은 사이클을 다시 기록하는 경우입니다. 되돌리면 이미 체결된
  // 주문을 미체결로 보고 다시 냅니다.
  const orders = buildOrders([
    { type: "PLANNED", clientOrderId: "A", symbol: "VTI", side: "BUY", requestedUsd: 10 },
    { type: "FILL", clientOrderId: "A", filledUsd: 10, filledQuantity: 0.1 },
    { type: "PLANNED", clientOrderId: "A", symbol: "VTI", side: "BUY", requestedUsd: 10 },
  ]);
  assert.equal(orders.get("A").state, ORDER_STATES.FILLED);
});

test("결말이 안 난 주문을 찾아낸다 — 이것이 비어야 다음 사이클을 돈다", () => {
  const orders = buildOrders([
    { type: "PLANNED", clientOrderId: "열림", symbol: "VTI", side: "BUY", requestedUsd: 10 },
    { type: "PLANNED", clientOrderId: "체결", symbol: "VTI", side: "BUY", requestedUsd: 10 },
    { type: "FILL", clientOrderId: "체결", filledUsd: 10, filledQuantity: 0.1 },
    { type: "PLANNED", clientOrderId: "거절", symbol: "IWM", side: "BUY", requestedUsd: 5 },
    { type: "REJECTED", clientOrderId: "거절", reason: "잔고 부족" },
    { type: "PLANNED", clientOrderId: "절반", symbol: "SCHD", side: "BUY", requestedUsd: 10 },
    { type: "FILL", clientOrderId: "절반", filledUsd: 5, filledQuantity: 0.05 },
  ]);

  const pending = unresolvedOrders(orders).map((order) => order.clientOrderId).sort();
  // 부분 체결도 포함합니다 — 나머지가 아직 시장에 살아 있을 수 있고,
  // 그 위에 새 주문을 얹으면 의도한 것보다 많이 삽니다.
  assert.deepEqual(pending, ["열림", "절반"]);
});

test("응답을 못 받아도 브로커에는 접수돼 있을 수 있다 — 조회로만 알 수 있다", async () => {
  // 가장 위험한 경우입니다. 우리 쪽에는 예외만 남습니다.
  const broker = createFakeBroker({ behaviors: [{ timeout: true }] });
  const id = clientOrderId({ cycleAt: "2026-08-07T14:30:00Z", symbol: "VTI", side: "BUY" });

  await assert.rejects(
    () => broker.submitOrder({ clientOrderId: id, symbol: "VTI", side: "BUY", amountUsd: 10 }),
    /시간 초과/,
  );

  // 예외만 보고 "안 나갔다"고 판단하면 재시도가 중복 주문이 됩니다.
  const found = await broker.getOrder(id);
  assert.ok(found, "브로커에는 남아 있다");
  assert.equal(found.status, "OPEN");
});

test("낸 적 없는 주문 조회는 오류가 아니라 null이다", async () => {
  // "안 냈다"와 "조회에 실패했다"는 정반대 대응을 요구합니다. 오류로 뭉뚱그리면
  // 구분할 수 없습니다.
  assert.equal(await createFakeBroker().getOrder("없는주문"), null);
});

test("체결된 것만으로 실제 포지션 변화를 낸다 — 의도가 아니라 사실이다", () => {
  const orders = buildOrders([
    { type: "PLANNED", clientOrderId: "A", symbol: "VTI", side: "BUY", requestedUsd: 10 },
    { type: "FILL", clientOrderId: "A", filledUsd: 4, filledQuantity: 0.04 },
    // 거절된 주문은 의도만 있고 체결이 없으므로 포지션을 바꾸지 않습니다.
    { type: "PLANNED", clientOrderId: "B", symbol: "VTI", side: "BUY", requestedUsd: 10 },
    { type: "REJECTED", clientOrderId: "B", reason: "거래 정지" },
    { type: "PLANNED", clientOrderId: "C", symbol: "IWM", side: "SELL", requestedUsd: 3 },
    { type: "FILL", clientOrderId: "C", filledUsd: 3, filledQuantity: 0.03 },
  ]);

  const fills = realizedFills(orders);
  assert.equal(fills.get("VTI").usd, 4, "체결된 4달러만 센다");
  assert.equal(fills.get("IWM").usd, -3, "매도는 음수다");
});

test("브로커와 장부가 어긋나면 대사가 잡아낸다", () => {
  // 브로커가 진실입니다. 우리 장부는 의도의 기록일 뿐입니다.
  const result = reconcile({ VTI: 43.83, IWM: 3.69 }, { VTI: 43.83, IWM: 1.08 });
  assert.equal(result.matched, false);
  assert.equal(result.differences.length, 1);
  assert.equal(result.differences[0].symbol, "IWM");
  assert.equal(result.differences[0].gapUsd, -2.61);
});

test("센트 단위 반올림 차이는 어긋남으로 보지 않는다", () => {
  assert.equal(reconcile({ VTI: 43.83 }, { VTI: 43.85 }).matched, true);
});

test("장부에 없는 종목을 브로커가 들고 있으면 잡아낸다", () => {
  // 수동 매매나 이전 배포의 잔재입니다. 모르고 리밸런싱하면 안 됩니다.
  const result = reconcile({ VTI: 40 }, { VTI: 40, QQQ: 12 });
  assert.equal(result.matched, false);
  assert.equal(result.differences[0].symbol, "QQQ");
});

test("긴급 중지는 이미 낸 주문을 거둘 수 있어야 실효가 있다", async () => {
  const broker = createFakeBroker({ behaviors: [{ accept: true }] });
  const id = "긴급";
  await broker.submitOrder({ clientOrderId: id, symbol: "VTI", side: "BUY", amountUsd: 10 });

  assert.equal((await broker.listOpenOrders()).length, 1);
  assert.equal((await broker.cancelOrder(id)).canceled, true);
  assert.equal((await broker.listOpenOrders()).length, 0);
});

test("이미 체결된 주문은 취소되지 않는다", async () => {
  const broker = createFakeBroker({ behaviors: [{ fill: 1 }] });
  await broker.submitOrder({ clientOrderId: "끝", symbol: "VTI", side: "BUY", amountUsd: 10 });
  assert.equal((await broker.cancelOrder("끝")).canceled, false);
});
