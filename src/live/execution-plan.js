import { unresolvedOrders } from "./order-lifecycle.js";

/**
 * 한 사이클에 **무엇을 낼지, 아니면 멈출지**를 정하는 순수 함수입니다.
 *
 * 주문을 실제로 내는 코드와 나눠 둡니다. 낼지 말지를 정하는 판단은 네트워크도
 * 시간도 없이 테스트할 수 있어야 하고, 실거래에서 다치는 곳이 정확히 이 판단이기
 * 때문입니다.
 *
 * 순서가 곧 우선순위입니다. **멈출 이유를 먼저 다 보고, 남으면 그때 하나를 냅니다.**
 */

/**
 * 한 번에 띄우는 주문 수입니다. 기본 1입니다.
 *
 * **왜 직렬화하는가** — 브로커가 우리 주문 아이디를 안 받아 주면, 응답을 못
 * 받았을 때(타임아웃·크래시) 그 주문을 조회할 열쇠가 없습니다. 그때 남은 방법은
 * "최근 주문 목록에서 종목·방향·금액으로 찾아 맞추기"인데, **동시에 여러 건을
 * 띄웠으면 어느 것이 어느 것인지 가릴 수 없습니다.**
 *
 * 하나만 띄우면 후보가 정확히 하나라 조회로 결말이 납니다. 우리 회전율은 연 2.8회고
 * 사이클은 15분마다 오므로 직렬화 비용은 사실상 없습니다 — 주문 셋이 밀려도
 * 45분입니다.
 *
 * 브로커가 우리 아이디(멱등키)를 받아 준다는 것이 **문서로 확인되면** 이 값을
 * 올려도 됩니다. 확인 전에는 올리지 않습니다.
 */
export const DEFAULT_MAX_IN_FLIGHT = 1;

/** 대사 차이는 수량입니다. 부호를 붙이고 체결 눈금(1e-6)까지 냅니다. */
function formatGap(gap) {
  if (!Number.isFinite(Number(gap))) return "(조회 실패)";
  const value = Number(gap);
  return `${value > 0 ? "+" : ""}${value.toFixed(6)}`;
}

export const HALT_REASONS = Object.freeze({
  EMERGENCY_STOP: "EMERGENCY_STOP",
  UNRESOLVED_ORDERS: "UNRESOLVED_ORDERS",
  RECONCILE_MISMATCH: "RECONCILE_MISMATCH",
  MARKET_CLOSED: "MARKET_CLOSED",
  AMOUNT_ORDER_WINDOW_CLOSED: "AMOUNT_ORDER_WINDOW_CLOSED",
});

/**
 * @param {object} input
 * @param {Array}  input.decisions       엔진이 낸 주문 의도 (PAPER와 같은 모양)
 * @param {Map}    input.orders          `buildOrders()` 결과 — 지금까지의 주문 상태
 * @param {object} input.reconciliation  `reconcile()` 결과
 * @param {boolean} input.emergencyStop  긴급 중지 플래그
 * @param {boolean} input.marketOpen
 * @param {boolean} input.amountOrderWindowOpen 금액 주문 접수 시간인가(정규장 종료 1시간 전까지)
 */
export function planCycle({
  decisions = [],
  orders = new Map(),
  reconciliation = { matched: true, differences: [] },
  emergencyStop = false,
  marketOpen = true,
  amountOrderWindowOpen = true,
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
}) {
  // ① 긴급 중지가 가장 앞입니다. 다른 어떤 판단보다 먼저 이깁니다.
  if (emergencyStop) {
    return halt(HALT_REASONS.EMERGENCY_STOP, "긴급 중지가 켜져 있습니다. 신규 주문을 내지 않습니다.");
  }

  // ② 결말이 안 난 주문이 있으면 새 주문을 내지 않습니다. 그 위에 얹으면
  //    같은 매수를 두 번 하거나 이미 팔린 것을 또 팔게 됩니다.
  const pending = unresolvedOrders(orders);
  if (pending.length >= maxInFlight) {
    return halt(
      HALT_REASONS.UNRESOLVED_ORDERS,
      `결말이 안 난 주문 ${pending.length}건이 있습니다: ` +
        `${pending.map((order) => order.clientOrderId).join(", ")}. 조회로 먼저 결말을 지으십시오.`,
      { pending },
    );
  }

  // ③ 브로커와 장부가 어긋나면 멈춥니다. 어긋난 보유를 기준으로 목표 비중을
  //    계산하면 오차를 줄이는 게 아니라 키웁니다.
  if (!reconciliation.matched) {
    return halt(
      HALT_REASONS.RECONCILE_MISMATCH,
      // **수량이므로 여섯째 자리까지 냅니다.** 센트 자리로 반올림하면 VTI
      // 0.005248이 0.01로, 그보다 작은 차이는 0으로 보입니다 — 멈춘 이유를
      // 읽어야 할 자리에서 "차이 0"을 보게 됩니다.
      `브로커와 장부가 어긋납니다: ` +
        reconciliation.differences
          .map((item) => `${item.symbol} ${formatGap(item.gap)}`)
          .join(", "),
      { differences: reconciliation.differences },
    );
  }

  if (!marketOpen) {
    return halt(HALT_REASONS.MARKET_CLOSED, "정규장이 아닙니다.");
  }

  // 시드가 작아 금액 주문만 쓰므로, 정규장이어도 이 창이 닫혔으면 낼 수 없습니다.
  // 내봐야 `amount-order-outside-regular-hours`로 거부되고 호출 한도만 씁니다.
  if (!amountOrderWindowOpen) {
    return halt(
      HALT_REASONS.AMOUNT_ORDER_WINDOW_CLOSED,
      "금액 주문 접수 시간이 지났습니다(정규장 종료 1시간 전까지). 다음 거래일로 미룹니다.",
    );
  }

  if (decisions.length === 0) {
    return { halted: false, submit: [], skipped: [], reason: null };
  }

  // 낼 수 있는 만큼만 내고 나머지는 다음 사이클로 미룹니다. **버리는 것이
  // 아니라 미루는 것**입니다 — 다음 사이클에 신호가 그대로면 다시 올라옵니다.
  const capacity = Math.max(0, maxInFlight - pending.length);
  return {
    halted: false,
    submit: decisions.slice(0, capacity),
    skipped: decisions.slice(capacity),
    reason: null,
  };
}

function halt(reason, message, extra = {}) {
  return { halted: true, submit: [], skipped: [], reason, message, ...extra };
}
