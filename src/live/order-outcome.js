/**
 * 주문 제출의 결과를 **다음에 무엇을 해도 되는지**로 번역합니다.
 *
 * 이 파일이 따로 있는 이유는 하나입니다 — **재제출해도 되는 경우와 절대 안 되는
 * 경우를 한 곳에서만 정하기 위해서**입니다. 호출부마다 예외를 보고 판단하면
 * 언젠가 한 곳이 "실패했으니 다시 내자"로 처리하고, 그것이 중복 매수가 됩니다.
 *
 * 토스증권 Open API의 멱등 규약(2026-08-07 확인):
 *   같은 clientOrderId + 같은 내용  → 중복 처리를 막아 준다
 *   같은 clientOrderId + 처리 중    → `request-in-progress`
 *   같은 clientOrderId + 다른 내용  → `idempotency-key-conflict`
 *
 * **conflict가 나면 아이디에 금액을 섞어 새 아이디를 만들고 싶어지는데, 그것이
 * 정확히 사고로 가는 길입니다.** 그렇게 하면 재시도가 새 주문이 되어 같은 매수를
 * 두 번 합니다. conflict는 "이미 뭔가 보냈다"는 확실한 신호이므로, 아이디는 그대로
 * 두고 조회로 결말을 지어야 합니다.
 */

export const OUTCOMES = Object.freeze({
  /** 브로커가 접수를 확인해 줬다. 유일하게 다음 단계로 나아가는 결과다. */
  ACCEPTED: "ACCEPTED",
  /** 브로커가 명시적으로 거절했다. 주문은 존재하지 않는다 — 다시 내도 안전하다. */
  REJECTED: "REJECTED",
  /** 냈는지 안 냈는지 모른다. **조회로만 알 수 있다.** */
  NEEDS_LOOKUP: "NEEDS_LOOKUP",
});

/**
 * 조회로 결말을 지어야 하는 토스 오류 코드입니다(가이드 2026-08-07).
 *
 * 전부 **"주문이 이미 존재한다"**는 뜻입니다. 오류처럼 생겼지만 실은 가장 확실한
 * 정보이고, 그래서 재제출하면 안 됩니다.
 */
export const LOOKUP_REQUIRED_CODES = Object.freeze([
  "request-in-progress",        // 409 동일 clientOrderId 처리 중
  "idempotency-key-conflict",   // 422 같은 clientOrderId로 다른 내용
  "already-filled",             // 409 이미 체결됨
  "already-canceled",           // 409 이미 취소됨
  "already-modified",           // 409 이미 정정됨
  "already-rejected",           // 409 이미 거부됨
  "already-processing",         // 409 같은 주문의 정정·취소 처리 중
]);

/**
 * 주문이 **접수되지 않았음이 확실한** 코드입니다. 다시 내도 중복이 되지 않습니다.
 *
 * 다만 "다시 내도 안전하다"가 "지금 다시 내라"는 뜻은 아닙니다. 대부분 원인이
 * 사라져야 성공하므로(잔고 부족, 장 시간 아님, 계좌 제한) 상위에서 다음 사이클로
 * 미룹니다. 여기서 구분하는 이유는 **미결로 남겨 매매를 멈출 필요가 없다**는 것
 * 하나뿐입니다.
 */
export const DEFINITELY_NOT_PLACED_CODES = Object.freeze([
  "invalid-request",                     // 400 파라미터가 잘못됨
  "account-header-required",             // 400 계좌 헤더 누락
  "unsupported-symbol",                  // 400
  "insufficient-buying-power",           // 422 매수 가능 금액 부족
  "insufficient-sellable-quantity",      // 422 매도 가능 수량 부족
  "order-hours-closed",                  // 422 주문 접수 시간 아님
  "amount-order-outside-regular-hours",  // 422 금액 주문 시간 아님
  "stock-restricted",                    // 422 거래 제한 종목
  "order-type-not-allowed",              // 422
  "opposite-pending-order-exists",       // 422 같은 종목 반대 방향 미체결 존재
  "prerequisite-required",               // 422 약관·교육·위험고지 미충족
  "account-restricted",                  // 422 계좌 상태가 주문을 허용하지 않음
  "order-limit-exceeded",                // 422 주문 설정 한도 초과
  "market-not-supported-for-stock",      // 422
  "unsupported-content-type",            // 415
]);

/**
 * 응답이나 예외를 결과로 번역합니다.
 *
 * **판단 기준은 "주문이 존재할 수 있는가"이지 "요청이 성공했는가"가 아닙니다.**
 * 요청이 실패해도 주문은 접수돼 있을 수 있고, 그 경우 재제출하면 두 번 삽니다.
 */
export function classifyOutcome({ response = null, error = null } = {}) {
  if (error) {
    const code = error.code ?? null;

    // 멱등 충돌과 처리 중은 **둘 다 "이미 보냈다"는 증거**입니다. 오류처럼
    // 생겼지만 실은 가장 확실한 정보입니다.
    if (LOOKUP_REQUIRED_CODES.includes(code)) {
      return {
        outcome: OUTCOMES.NEEDS_LOOKUP,
        mayResubmit: false,
        code,
        why: `이미 접수된 주문이 있습니다(${code}). 조회로 결말을 지으십시오.`,
      };
    }

    // 접수되지 않았음이 확실한 코드들입니다. 미결로 남겨 매매를 멈출 이유가 없습니다.
    // **인증 실패(401)도 여기 넣지 않습니다** — 엣지에서 막힌 것이 확실해 보여도,
    // 틀렸을 때의 대가가 중복 매수라 확신에 기대지 않습니다.
    if (DEFINITELY_NOT_PLACED_CODES.includes(code)) {
      return {
        outcome: OUTCOMES.REJECTED,
        mayResubmit: true,
        code,
        why: `${error.message} (${code})`,
      };
    }

    // 그 밖의 오류(타임아웃·네트워크·5xx)는 접수 여부를 알 수 없습니다.
    // **모르는 것은 재제출하지 않습니다.**
    return {
      outcome: OUTCOMES.NEEDS_LOOKUP,
      mayResubmit: false,
      code,
      why: `접수 여부를 알 수 없습니다(${error.message}). 조회로 확인하십시오.`,
    };
  }

  if (response?.status === "REJECTED") {
    // 브로커가 명시적으로 거절한 것만 "주문이 없다"고 확신할 수 있습니다.
    return {
      outcome: OUTCOMES.REJECTED,
      mayResubmit: true,
      code: response.code ?? null,
      why: response.reason ?? "브로커가 거절했습니다.",
    };
  }

  if (response?.brokerOrderId) {
    return { outcome: OUTCOMES.ACCEPTED, mayResubmit: false, code: null, why: null };
  }

  // 응답은 왔는데 주문번호가 없습니다. 성공으로 볼 근거가 없으므로 조회합니다.
  return {
    outcome: OUTCOMES.NEEDS_LOOKUP,
    mayResubmit: false,
    code: null,
    why: "응답에 주문번호가 없습니다. 조회로 확인하십시오.",
  };
}

/**
 * 조회 결과를 원장에 적을 이벤트로 바꿉니다.
 *
 * **브로커가 진실입니다.** 우리가 무엇을 기대했든, 조회가 말하는 것이 실제로
 * 일어난 일입니다.
 *
 * @param {object|null} brokerOrder `getOrder()` 결과. **없으면 null**이어야 하고,
 *   그 null은 "접수되지 않았다"는 확실한 사실입니다 — 오류와 구분돼야 합니다.
 */
export function eventsFromLookup(clientOrderId, brokerOrder, { at = new Date().toISOString() } = {}) {
  if (brokerOrder === null) {
    // 안 나갔습니다. 취소로 닫아 결말을 짓습니다 — 열린 채로 두면 다음 사이클이
    // 영영 멈춥니다.
    return [{
      type: "CANCELED", clientOrderId, at,
      reason: "브로커에 접수되지 않았습니다(조회 결과 없음).",
    }];
  }

  const events = [{
    type: "SUBMITTED", clientOrderId, at,
    brokerOrderId: brokerOrder.brokerOrderId ?? brokerOrder.orderId ?? null,
  }];

  if (brokerOrder.status === "REJECTED") {
    events.push({ type: "REJECTED", clientOrderId, at, reason: brokerOrder.reason ?? null });
    return events;
  }

  if (Number(brokerOrder.filledUsd) > 0) {
    events.push({
      type: "FILL", clientOrderId, at,
      filledUsd: Number(brokerOrder.filledUsd),
      filledQuantity: Number(brokerOrder.filledQuantity) || 0,
      filledPrice: brokerOrder.filledPrice ?? null,
      fees: brokerOrder.fees ?? null,
    });
  }

  if (brokerOrder.status === "CANCELED") {
    events.push({ type: "CANCELED", clientOrderId, at, reason: "브로커에서 취소됨" });
  }

  return events;
}

/**
 * 결말이 안 난 주문들을 조회해 결말을 짓습니다. 재제출은 **하지 않습니다** —
 * 이 함수의 목적은 사실을 확인하는 것이지 의도를 재시도하는 것이 아닙니다.
 *
 * 조회 자체가 실패하면 그 주문은 미결로 남습니다. 그러면 다음 사이클도 멈추는데,
 * **그것이 맞는 동작입니다.** 상태를 모르는 채로 매매하는 것보다 멈추는 편이 낫습니다.
 */
export async function resolveOrders(broker, pendingOrders, { at, onError } = {}) {
  const events = [];
  const stillUnresolved = [];

  for (const order of pendingOrders) {
    try {
      const found = await broker.getOrder(order.clientOrderId);
      events.push(...eventsFromLookup(order.clientOrderId, found, { at }));
    } catch (error) {
      stillUnresolved.push({ clientOrderId: order.clientOrderId, message: error.message });
      onError?.(order, error);
    }
  }

  return { events, stillUnresolved };
}
