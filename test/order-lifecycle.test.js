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
import { HALT_REASONS, planCycle } from "../src/live/execution-plan.js";
import {
  OUTCOMES,
  classifyOutcome,
  eventsFromLookup,
  resolveOrders,
} from "../src/live/order-outcome.js";
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

/**
 * ── 사이클 계획 ───────────────────────────────────────────────────────────
 *
 * "무엇을 낼지, 아니면 멈출지"를 정하는 판단입니다. 실거래에서 다치는 곳이
 * 정확히 여기라, 네트워크도 시간도 없이 테스트할 수 있게 떼어 놨습니다.
 */

const DECISIONS = [
  { symbol: "VTI", side: "BUY", amountUsd: 5 },
  { symbol: "SCHD", side: "BUY", amountUsd: 3 },
];

test("긴급 중지는 다른 모든 판단보다 먼저 이긴다", () => {
  const plan = planCycle({ decisions: DECISIONS, emergencyStop: true });
  assert.equal(plan.halted, true);
  assert.equal(plan.reason, HALT_REASONS.EMERGENCY_STOP);
  assert.deepEqual(plan.submit, []);
});

test("결말이 안 난 주문이 있으면 새 주문을 내지 않는다", () => {
  const orders = buildOrders([
    { type: "PLANNED", clientOrderId: "열림", symbol: "VTI", side: "BUY", requestedUsd: 10 },
  ]);
  const plan = planCycle({ decisions: DECISIONS, orders });
  assert.equal(plan.reason, HALT_REASONS.UNRESOLVED_ORDERS);
  assert.match(plan.message, /열림/);
});

test("브로커와 장부가 어긋나면 멈춘다", () => {
  const plan = planCycle({
    decisions: DECISIONS,
    reconciliation: reconcile({ IWM: 3.69 }, { IWM: 1.08 }),
  });
  assert.equal(plan.reason, HALT_REASONS.RECONCILE_MISMATCH);
  assert.match(plan.message, /IWM/);
});

test("기본은 한 번에 하나만 내고 나머지는 미룬다", () => {
  // 브로커가 우리 주문 아이디를 안 받아 주면, 응답을 못 받았을 때 후보가
  // 여럿이면 어느 것인지 가릴 수 없다. 하나만 띄우면 조회로 결말이 난다.
  const plan = planCycle({ decisions: DECISIONS });
  assert.equal(plan.halted, false);
  assert.deepEqual(plan.submit, [DECISIONS[0]]);
  assert.deepEqual(plan.skipped, [DECISIONS[1]], "버리는 것이 아니라 미룬다");
});

test("멱등키가 확인되면 동시 주문 수를 올릴 수 있다", () => {
  const plan = planCycle({ decisions: DECISIONS, maxInFlight: 2 });
  assert.equal(plan.submit.length, 2);
  assert.deepEqual(plan.skipped, []);
});

test("장이 닫혀 있으면 내지 않는다", () => {
  assert.equal(planCycle({ decisions: DECISIONS, marketOpen: false }).reason, HALT_REASONS.MARKET_CLOSED);
});

test("낼 것이 없으면 멈춘 것이 아니라 그냥 빈 계획이다", () => {
  const plan = planCycle({ decisions: [] });
  assert.equal(plan.halted, false, "거래 없음은 사고가 아니다");
  assert.deepEqual(plan.submit, []);
});

/**
 * ── 멱등 규약 ─────────────────────────────────────────────────────────────
 *
 * 토스증권은 주문 본문의 clientOrderId로 중복을 막습니다(2026-08-07 확인).
 * 같은 아이디 + 다른 내용이면 idempotency-key-conflict, 처리 중이면
 * request-in-progress입니다. **둘 다 오류처럼 생겼지만 "이미 보냈다"는
 * 가장 확실한 증거이고, 그래서 재제출하면 안 됩니다.**
 */

test("접수 확인만이 다음 단계로 나아간다", () => {
  const accepted = classifyOutcome({ response: { brokerOrderId: "BRK-1" } });
  assert.equal(accepted.outcome, OUTCOMES.ACCEPTED);
});

test("명시적 거절만 재제출해도 안전하다 — 주문이 존재하지 않기 때문", () => {
  const rejected = classifyOutcome({ response: { status: "REJECTED", reason: "잔고 부족" } });
  assert.equal(rejected.outcome, OUTCOMES.REJECTED);
  assert.equal(rejected.mayResubmit, true);
});

test("멱등 충돌과 처리 중은 재제출 금지다", () => {
  for (const code of ["idempotency-key-conflict", "request-in-progress"]) {
    const error = Object.assign(new Error("x"), { code });
    const outcome = classifyOutcome({ error });
    assert.equal(outcome.outcome, OUTCOMES.NEEDS_LOOKUP, code);
    assert.equal(outcome.mayResubmit, false, code);
  }
});

test("타임아웃도 재제출 금지다 — 접수 여부를 모르기 때문", () => {
  const outcome = classifyOutcome({ error: new Error("응답 시간 초과") });
  assert.equal(outcome.outcome, OUTCOMES.NEEDS_LOOKUP);
  assert.equal(outcome.mayResubmit, false);
});

test("주문번호 없는 응답은 성공으로 보지 않는다", () => {
  assert.equal(classifyOutcome({ response: {} }).outcome, OUTCOMES.NEEDS_LOOKUP);
});

test("조회 결과 없음은 확실한 사실이라 결말을 짓는다", () => {
  // 열린 채로 두면 다음 사이클이 영영 멈춥니다.
  const events = eventsFromLookup("A", null);
  assert.equal(events[0].type, "CANCELED");
  assert.equal(buildOrders([{ type: "PLANNED", clientOrderId: "A", requestedUsd: 5 }, ...events])
    .get("A").state, ORDER_STATES.CANCELED);
});

test("멱등 충돌 뒤 조회하면 실제로 접수된 주문이 나온다", async () => {
  const broker = createFakeBroker({ behaviors: [{ conflict: true }] });
  const id = "충돌";

  let caught = null;
  try {
    await broker.submitOrder({ clientOrderId: id, symbol: "VTI", side: "BUY", amountUsd: 5 });
  } catch (error) {
    caught = error;
  }

  const outcome = classifyOutcome({ error: caught });
  assert.equal(outcome.mayResubmit, false, "여기서 재제출하면 중복 매수다");

  // 조회가 결말을 짓습니다.
  const found = await broker.getOrder(id);
  assert.ok(found, "충돌은 이미 보냈다는 증거다");
});

test("미결 주문을 조회해 결말을 짓되 재제출은 하지 않는다", async () => {
  const broker = createFakeBroker({ behaviors: [{ timeout: true }] });
  const id = "복구";
  await assert.rejects(() =>
    broker.submitOrder({ clientOrderId: id, symbol: "VTI", side: "BUY", amountUsd: 5 }));

  const before = buildOrders([
    { type: "PLANNED", clientOrderId: id, symbol: "VTI", side: "BUY", requestedUsd: 5 },
  ]);
  const { events, stillUnresolved } = await resolveOrders(broker, unresolvedOrders(before));

  assert.deepEqual(stillUnresolved, []);
  // 브로커에 살아 있었으므로 SUBMITTED로 결말이 납니다. 주문은 하나뿐입니다.
  assert.equal(events[0].type, "SUBMITTED");
  assert.equal(broker._orders.size, 1, "재제출하지 않았다");
});

test("조회 자체가 실패하면 미결로 남긴다 — 모르는 채로 매매하지 않는다", async () => {
  const broker = createFakeBroker();
  broker.getOrder = async () => { throw new Error("조회 실패"); };

  const orders = buildOrders([
    { type: "PLANNED", clientOrderId: "X", symbol: "VTI", side: "BUY", requestedUsd: 5 },
  ]);
  const { events, stillUnresolved } = await resolveOrders(broker, unresolvedOrders(orders));

  assert.deepEqual(events, []);
  assert.equal(stillUnresolved.length, 1);
  // 다음 사이클도 멈춥니다. 그것이 맞는 동작입니다.
  assert.equal(planCycle({ decisions: DECISIONS, orders }).reason, HALT_REASONS.UNRESOLVED_ORDERS);
});

test("이미 존재한다는 뜻의 코드는 모두 재제출 금지다", () => {
  // 가이드의 409 계열입니다. 오류처럼 생겼지만 "주문이 있다"는 확실한 정보입니다.
  for (const code of [
    "already-filled", "already-canceled", "already-rejected",
    "already-modified", "already-processing",
  ]) {
    const outcome = classifyOutcome({ error: Object.assign(new Error("x"), { code }) });
    assert.equal(outcome.mayResubmit, false, code);
  }
});

test("접수되지 않았음이 확실한 코드는 미결로 남기지 않는다", () => {
  // 미결로 두면 매매가 멈추는데, 이 코드들은 주문이 없다는 것이 확실하므로
  // 멈출 이유가 없습니다. 다음 사이클에 원인이 사라지면 다시 시도됩니다.
  for (const code of [
    "insufficient-buying-power", "order-hours-closed",
    "amount-order-outside-regular-hours", "prerequisite-required",
    "opposite-pending-order-exists", "account-restricted",
  ]) {
    const outcome = classifyOutcome({ error: Object.assign(new Error("x"), { code }) });
    assert.equal(outcome.outcome, OUTCOMES.REJECTED, code);
  }
});

test("인증 실패는 확실해 보여도 재제출 가능으로 두지 않는다", () => {
  // 엣지에서 막힌 것이 거의 확실하지만, 틀렸을 때의 대가가 중복 매수다.
  const outcome = classifyOutcome({
    error: Object.assign(new Error("만료"), { code: "expired-token" }),
  });
  assert.equal(outcome.outcome, OUTCOMES.NEEDS_LOOKUP);
});

test("브로커가 전량 체결이라고 하면 잔액이 남아도 끝난 것이다", () => {
  // 2026-08-07 실측: $2.00 요청에 $1.99 체결. 금액 주문은 수량 단위 때문에
  // 항상 조금 적게 체결된다. 잔액으로 추정하면 영원히 PARTIAL이 되고,
  // PARTIAL은 미결이므로 에이전트가 영구 정지한다.
  const orders = buildOrders([
    { type: "PLANNED", clientOrderId: "A", symbol: "SCHD", side: "BUY", requestedUsd: 2 },
    { type: "FILL", clientOrderId: "A", filledUsd: 1.94, filledQuantity: 0.0579, terminal: true },
  ]);
  assert.equal(orders.get("A").state, ORDER_STATES.FILLED, "6센트가 남아도 끝난 것이다");
  assert.deepEqual(unresolvedOrders(orders), [], "미결로 남지 않는다");
});

test("브로커 상태를 모를 때만 금액으로 추정한다", () => {
  const orders = buildOrders([
    { type: "PLANNED", clientOrderId: "A", symbol: "SCHD", side: "BUY", requestedUsd: 10 },
    { type: "FILL", clientOrderId: "A", filledUsd: 4, filledQuantity: 0.12 },
  ]);
  assert.equal(orders.get("A").state, ORDER_STATES.PARTIAL, "정말 절반만 체결된 경우");
});

test("조회 결과가 전량 체결이면 terminal을 실어 보낸다", () => {
  const [, fill] = eventsFromLookup("A", {
    brokerOrderId: "OID", status: "FILLED", filledUsd: 1.99, filledQuantity: 0.05965,
  });
  assert.equal(fill.terminal, true);

  const [, partial] = eventsFromLookup("B", {
    brokerOrderId: "OID", status: "PARTIAL", filledUsd: 1, filledQuantity: 0.03,
  });
  assert.equal(partial.terminal, false);
});
