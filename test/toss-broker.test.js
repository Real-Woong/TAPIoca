import test from "node:test";
import assert from "node:assert/strict";

import { assertBrokerContract } from "../src/live/broker-contract.js";
import { ORDER_STATES } from "../src/live/order-lifecycle.js";
import { createRateLimiter } from "../src/live/rate-limiter.js";
import {
  IDEMPOTENCY_WINDOW_MS,
  TossOrderError,
  canReplaySafely,
  createTossBroker,
} from "../src/live/toss-broker.js";
import { mapTossStatus, normalizeTossOrder, requiresHuman } from "../src/live/toss-order-status.js";

/** 요청을 기록하고 정해진 응답을 돌려주는 fetch입니다. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? "GET", body: options?.body ? JSON.parse(options.body) : null, headers: options?.headers });
    const next = queue.shift() ?? { status: 200, body: { result: null } };
    return {
      ok: next.status < 400,
      status: next.status,
      headers: new Headers(next.headers ?? {}),
      json: async () => next.body,
    };
  };
  impl.calls = calls;
  return impl;
}

const broker = (fetchImpl, extra = {}) => createTossBroker({
  getAccessToken: async () => "T", accountSeq: "123", fetchImpl,
  rateLimiter: createRateLimiter({ sleep: async () => {} }),
  ...extra,
});

test("어댑터가 가짜 브로커와 같은 계약을 지킨다", () => {
  assert.equal(assertBrokerContract(broker(fakeFetch([]))), true);
});

test("금액 주문은 US + MARKET 조합으로 나가고 금액은 센트로 고정한다", async () => {
  const impl = fakeFetch([{ status: 200, body: { result: { orderId: "OID-1", clientOrderId: "C-1" } } }]);
  const result = await broker(impl).submitOrder({
    clientOrderId: "C-1", symbol: "VTI", side: "BUY", amountUsd: 9.999,
  });

  const call = impl.calls[0];
  assert.equal(call.method, "POST");
  assert.match(call.url, /\/api\/v1\/orders$/);
  assert.equal(call.body.orderType, "MARKET");
  // 부동소수 표기가 섞이면 멱등키 비교에서 "다른 내용"이 될 수 있습니다.
  assert.equal(call.body.orderAmount, "10.00");
  assert.equal(call.body.quantity, undefined, "금액 주문에 수량을 함께 보내면 거부된다");
  // 계좌는 본문이 아니라 헤더입니다.
  assert.equal(call.headers["x-tossinvest-account"], "123");
  assert.equal(result.brokerOrderId, "OID-1");
});

test("오류 응답의 code를 그대로 실어 던진다 — 멱등 판정이 이 값에 달려 있다", async () => {
  const impl = fakeFetch([{
    status: 409,
    body: { error: { code: "idempotency-key-conflict", message: "충돌", requestId: "R-1" } },
  }]);

  await assert.rejects(
    () => broker(impl).submitOrder({ clientOrderId: "C", symbol: "VTI", side: "BUY", amountUsd: 5 }),
    (error) => {
      assert.ok(error instanceof TossOrderError);
      assert.equal(error.code, "idempotency-key-conflict");
      assert.equal(error.requestId, "R-1");
      return true;
    },
  );
});

test("정규장 밖 금액 주문 오류도 코드로 구분된다", async () => {
  const impl = fakeFetch([{
    status: 400,
    body: { error: { code: "amount-order-outside-regular-hours", message: "정규장 종료 1시간 전까지" } },
  }]);
  await assert.rejects(
    () => broker(impl).submitOrder({ clientOrderId: "C", symbol: "VTI", side: "BUY", amountUsd: 5 }),
    (error) => error.code === "amount-order-outside-regular-hours",
  );
});

/** ── 상태 매핑 ────────────────────────────────────────────────────────── */

test("토스 상태를 우리 상태로 옮긴다", () => {
  assert.equal(mapTossStatus("PENDING").state, ORDER_STATES.SUBMITTED);
  assert.equal(mapTossStatus("PARTIAL_FILLED").state, ORDER_STATES.PARTIAL);
  assert.equal(mapTossStatus("FILLED").state, ORDER_STATES.FILLED);
  assert.equal(mapTossStatus("CANCELED").state, ORDER_STATES.CANCELED);
  assert.equal(mapTossStatus("REJECTED").state, ORDER_STATES.REJECTED);
});

test("취소·정정 거부를 종료 상태로 접지 않는다", () => {
  // 문서에 원주문 상태가 이전 상태로 되돌아갈 수 있다고 명시돼 있습니다.
  // CANCELED로 접으면 살아 있는 주문을 없는 것으로 보고 같은 매수를 또 냅니다.
  for (const status of ["CANCEL_REJECTED", "REPLACE_REJECTED", "REPLACED"]) {
    const mapped = mapTossStatus(status);
    assert.equal(mapped.state, ORDER_STATES.SUBMITTED, status);
    assert.equal(mapped.needsHuman, true, status);
    assert.equal(requiresHuman(status), true, status);
  }
});

test("모르는 상태는 멈춘다 — 토스가 상태값이 늘 수 있다고 명시한다", () => {
  const mapped = mapTossStatus("SOME_FUTURE_STATE");
  assert.equal(mapped.unknown, true);
  assert.equal(mapped.needsHuman, true);
  // 미결로 둬서 다음 사이클이 멈추게 합니다.
  assert.equal(mapped.state, ORDER_STATES.SUBMITTED);
});

test("취소 처리 중은 아직 미결이다", () => {
  assert.equal(mapTossStatus("PENDING_CANCEL").cancelPending, true);
  assert.equal(mapTossStatus("PENDING_CANCEL").state, ORDER_STATES.SUBMITTED);
});

test("문자열 숫자를 숫자로 바꾸고 수수료와 세금을 합친다", () => {
  const normalized = normalizeTossOrder({
    orderId: "OID", symbol: "VTI", side: "BUY", status: "PARTIAL_FILLED",
    quantity: "0.034", orderAmount: "10.00",
    execution: {
      filledQuantity: "0.017", averageFilledPrice: "293.50",
      filledAmount: "4.9895", commission: "0.01", tax: "0.02",
    },
  });

  assert.equal(normalized.filledUsd, 4.9895, "문자열을 그대로 더하면 이어붙기가 된다");
  assert.equal(normalized.filledPrice, 293.5);
  assert.ok(Math.abs(normalized.fees - 0.03) < 1e-9, "수수료+세금");
  assert.equal(normalized.status, ORDER_STATES.PARTIAL);
});

test("값이 없으면 0이 아니라 null이다 — 0과 '없음'은 다르다", () => {
  const normalized = normalizeTossOrder({
    orderId: "OID", status: "PENDING", quantity: "0.034", orderAmount: null,
    execution: { filledQuantity: "0", averageFilledPrice: null, filledAmount: null },
  });
  assert.equal(normalized.orderAmountUsd, null, "수량 주문이면 금액이 없다");
  assert.equal(normalized.filledPrice, null);
  assert.equal(normalized.filledQuantity, 0);
});

/** ── 조회와 복구 ──────────────────────────────────────────────────────── */

test("주문번호를 알면 상세로 조회한다", async () => {
  const impl = fakeFetch([{
    status: 200,
    body: { result: { orderId: "OID-1", symbol: "VTI", side: "BUY", status: "FILLED", execution: { filledAmount: "10.00", filledQuantity: "0.034" } } },
  }]);
  const found = await broker(impl, { lookupBrokerOrderId: async () => "OID-1" }).getOrder("C-1");

  assert.match(impl.calls[0].url, /\/api\/v1\/orders\/OID-1$/);
  assert.equal(found.status, ORDER_STATES.FILLED);
});

test("없는 주문(404)은 오류가 아니라 null이다", async () => {
  const impl = fakeFetch([{ status: 404, body: { error: { code: "order-not-found" } } }]);
  const found = await broker(impl, { lookupBrokerOrderId: async () => "OID-X" }).getOrder("C-1");
  assert.equal(found, null, "'안 냈다'는 확실한 사실이라 null이다");
});

test("주문번호를 모르고 단서도 없으면 null이다", async () => {
  // 상세 응답에 clientOrderId가 없으므로 우리 아이디로 곧장 조회할 수 없습니다.
  assert.equal(await broker(fakeFetch([])).getOrder("C-1"), null);
});

test("주문번호를 몰라도 단서가 하나만 맞으면 미결 목록에서 찾는다", async () => {
  const impl = fakeFetch([{
    status: 200,
    body: { result: { orders: [
      { orderId: "OID-A", symbol: "VTI", side: "BUY", status: "PENDING", orderAmount: "10.00", execution: {} },
      { orderId: "OID-B", symbol: "IWM", side: "BUY", status: "PENDING", orderAmount: "3.00", execution: {} },
    ] } },
  }]);

  const found = await broker(impl).getOrder("C-1", { symbol: "VTI", side: "BUY", amountUsd: 10 });
  assert.equal(found.brokerOrderId, "OID-A");
});

test("단서가 둘 이상 맞으면 못 찾은 것으로 답한다", async () => {
  // 아무거나 고르면 남의 주문(수동 매매·이전 배포)을 우리 것으로 착각합니다.
  // null을 내면 상위에서 미결로 남아 매매가 멈추므로 그것이 안전한 결말입니다.
  const impl = fakeFetch([{
    status: 200,
    body: { result: { orders: [
      { orderId: "OID-A", symbol: "VTI", side: "BUY", status: "PENDING", orderAmount: "10.00", execution: {} },
      { orderId: "OID-B", symbol: "VTI", side: "BUY", status: "PENDING", orderAmount: "10.00", execution: {} },
    ] } },
  }]);

  assert.equal(await broker(impl).getOrder("C-1", { symbol: "VTI", side: "BUY", amountUsd: 10 }), null);
});

test("주문번호를 모르면 취소를 성공으로 보고하지 않는다", async () => {
  // 성공으로 넘기면 살아 있는 주문을 취소됐다고 착각합니다.
  const result = await broker(fakeFetch([])).cancelOrder("C-1");
  assert.equal(result.canceled, false);
  assert.match(result.reason, /주문번호를 몰라/);
});

/** ── 멱등 창 ──────────────────────────────────────────────────────────── */

test("멱등 재전송은 10분 안에서만 안전하다", () => {
  const planned = "2026-08-07T14:30:00Z";
  const at = (ms) => new Date(new Date(planned).getTime() + ms);

  assert.equal(canReplaySafely(planned, at(60_000)), true, "1분 뒤");
  // 우리 사이클이 15분이라 재시작이 늦으면 창을 넘깁니다. 그때 재전송하면
  // 새 주문이 되어 곧바로 중복 매수입니다.
  assert.equal(canReplaySafely(planned, at(IDEMPOTENCY_WINDOW_MS + 1)), false, "10분 초과");
});

test("창이 닫히기 직전에는 안 된다고 답한다 — 경계에서 안전한 쪽으로 넘어진다", () => {
  const planned = "2026-08-07T14:30:00Z";
  // 판단하고 요청이 나가는 사이에 창이 닫힐 수 있고, 그 한 번이 중복 매수입니다.
  const justInside = new Date(new Date(planned).getTime() + IDEMPOTENCY_WINDOW_MS - 10_000);
  assert.equal(canReplaySafely(planned, justInside), false);
});

test("계획 시각을 모르면 재전송하지 않는다", () => {
  assert.equal(canReplaySafely(null), false);
  assert.equal(canReplaySafely("이상한값"), false);
});

test("토큰은 매 호출마다 물어본다 — 정적 문자열은 반드시 만료에 걸린다", async () => {
  let issued = 0;
  const impl = fakeFetch([{ status: 200, body: { result: { orders: [] } } }]);
  const b = createTossBroker({
    accountSeq: "1", fetchImpl: impl,
    rateLimiter: createRateLimiter({ sleep: async () => {} }),
    getAccessToken: async () => { issued += 1; return `T-${issued}`; },
  });

  await b.listOpenOrders();
  assert.equal(impl.calls[0].headers.authorization, "Bearer T-1");
  assert.equal(issued, 1, "호출할 때 받아 온다");
});

test("토큰 제공 함수가 없으면 만들지 못한다", () => {
  assert.throws(() => createTossBroker({ accountSeq: "1" }), /getAccessToken/);
});

test("보유는 수량으로 낸다 — 평가액은 가격 시점에 따라 흔들린다", async () => {
  const impl = fakeFetch([{
    status: 200,
    body: { result: { items: [
      { symbol: "VTI", quantity: "0.146" },
      { symbol: "SCHD", quantity: "0.482" },
    ] } },
  }]);

  assert.deepEqual(await broker(impl).getPositions(), { VTI: 0.146, SCHD: 0.482 });
});
