import { ORDER_STATES } from "./order-lifecycle.js";

/**
 * 토스증권 주문 상태를 우리 상태로 옮깁니다.
 *
 * **모르는 값은 멈춥니다.** 토스 문서가 "알 수 없는 상태값도 허용해서 구현하라"고
 * 명시하는데, 그 말은 상태가 늘어날 수 있다는 뜻입니다. 늘어난 값을 아무 상태로나
 * 접어 넣으면 조용히 틀린 판단을 하게 되므로, 모르면 사람을 부릅니다.
 */

/** 사람이 확인해야 하는 결과입니다. 자동으로 진행하지 않습니다. */
export const NEEDS_HUMAN = "NEEDS_HUMAN";

const MAPPING = Object.freeze({
  PENDING: { state: ORDER_STATES.SUBMITTED },
  PARTIAL_FILLED: { state: ORDER_STATES.PARTIAL },
  FILLED: { state: ORDER_STATES.FILLED },
  CANCELED: { state: ORDER_STATES.CANCELED },
  REJECTED: { state: ORDER_STATES.REJECTED },

  // 취소·정정이 처리 중입니다. 아직 원주문이 살아 있으므로 미결로 봅니다.
  PENDING_CANCEL: { state: ORDER_STATES.SUBMITTED, cancelPending: true },
  PENDING_REPLACE: { state: ORDER_STATES.SUBMITTED, replacePending: true },

  // **여기를 CANCELED나 REJECTED로 접으면 안 됩니다.** 토스 문서에 원주문 상태가
  // 이전 상태로 되돌아갈 수 있다고 명시돼 있습니다. 즉 "취소가 거부됐다"는 것은
  // 원주문이 아직 살아 있다는 뜻이고, 취소된 것으로 처리하면 이미 체결될 주문을
  // 없는 것으로 보고 같은 매수를 또 냅니다.
  CANCEL_REJECTED: { state: ORDER_STATES.SUBMITTED, needsHuman: true },
  REPLACE_REJECTED: { state: ORDER_STATES.SUBMITTED, needsHuman: true },
  // 원주문이 새 주문으로 대체됐습니다. 새 주문번호를 우리가 모르므로 대사가 필요합니다.
  REPLACED: { state: ORDER_STATES.SUBMITTED, needsHuman: true },
});

export function mapTossStatus(status) {
  const known = MAPPING[status];
  if (known) return { ...known, tossStatus: status, unknown: false };

  return {
    state: ORDER_STATES.SUBMITTED,
    tossStatus: status ?? null,
    unknown: true,
    needsHuman: true,
  };
}

/** 이 상태가 사람 확인을 요구하는지 한 줄로 봅니다. */
export function requiresHuman(status) {
  const mapped = mapTossStatus(status);
  return Boolean(mapped.needsHuman);
}

/**
 * 토스 주문 상세를 우리 모양으로 정규화합니다.
 *
 * 숫자가 **문자열로** 옵니다(`"0.017"`, `"10.00"`). 그대로 더하면 문자열 이어붙이기가
 * 되므로 여기서 한 번에 숫자로 바꿉니다. 값이 없으면 `null`이 오는데 `Number(null)`은
 * 0이라, 0과 "없음"을 구분해야 하는 곳에서는 그 차이가 중요합니다.
 */
export function normalizeTossOrder(order) {
  if (!order) return null;
  const execution = order.execution ?? {};
  const mapped = mapTossStatus(order.status);

  return {
    brokerOrderId: order.orderId ?? null,
    symbol: order.symbol ?? null,
    side: order.side ?? null,
    // 금액 주문이면 orderAmount에 값이 있고, 수량 주문이면 null입니다.
    orderAmountUsd: toNumber(order.orderAmount),
    quantity: toNumber(order.quantity),
    orderedAt: order.orderedAt ?? null,
    status: mapped.state,
    tossStatus: order.status ?? null,
    unknownStatus: mapped.unknown === true,
    needsHuman: Boolean(mapped.needsHuman),
    cancelPending: Boolean(mapped.cancelPending),
    replacePending: Boolean(mapped.replacePending),
    filledQuantity: toNumber(execution.filledQuantity) ?? 0,
    filledUsd: toNumber(execution.filledAmount) ?? 0,
    filledPrice: toNumber(execution.averageFilledPrice),
    // 수수료와 세금은 나눠 옵니다. 실측 비용을 가정(10bp)과 비교하려면 합쳐야 합니다.
    fees: (toNumber(execution.commission) ?? 0) + (toNumber(execution.tax) ?? 0),
    filledAt: execution.filledAt ?? null,
  };
}

/** 문자열 숫자를 숫자로. 값이 없으면 0이 아니라 null입니다. */
function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
