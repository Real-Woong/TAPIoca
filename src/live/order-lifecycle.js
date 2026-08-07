/**
 * 주문 이벤트 로그를 현재 상태로 접는 순수 함수들입니다.
 *
 * 상태를 파일에 저장하지 않고 매번 이벤트에서 다시 계산합니다. 저장된 상태와
 * 로그가 어긋나면 어느 쪽이 맞는지 판단할 방법이 없는데, 계산해서 쓰면 그런
 * 어긋남이 애초에 생기지 않습니다.
 */

/**
 * 주문 상태입니다.
 *
 *   PLANNED    기록만 됨. 브로커에 아직 안 냈거나, 냈는지 모름
 *   SUBMITTED  브로커가 접수를 확인해 줌
 *   PARTIAL    일부만 체결됨
 *   FILLED     전부 체결됨
 *   REJECTED   브로커가 거절함
 *   CANCELED   취소됨
 *
 * **PLANNED가 위험한 상태입니다.** "안 낸 것"과 "냈는데 응답을 못 받은 것"이
 * 같은 모양이기 때문입니다. 그래서 다음 사이클을 돌기 전에 반드시 조회로
 * 결말을 지어야 합니다 — `unresolvedOrders()`가 그것을 찾아 줍니다.
 */
export const ORDER_STATES = Object.freeze({
  PLANNED: "PLANNED",
  SUBMITTED: "SUBMITTED",
  PARTIAL: "PARTIAL",
  FILLED: "FILLED",
  REJECTED: "REJECTED",
  CANCELED: "CANCELED",
});

const TERMINAL = new Set([ORDER_STATES.FILLED, ORDER_STATES.REJECTED, ORDER_STATES.CANCELED]);

export function isTerminal(state) {
  return TERMINAL.has(state);
}

/**
 * 이벤트를 접어 주문별 현재 상태를 만듭니다.
 *
 * 체결은 여러 번 나뉘어 올 수 있으므로 **더하고**, 상태는 마지막 사실로
 * 갱신합니다. 요청 수량을 다 채우면 FILLED, 아니면 PARTIAL입니다.
 */
export function buildOrders(events) {
  const orders = new Map();

  for (const event of events ?? []) {
    const id = event.clientOrderId;
    if (!id) continue;

    if (!orders.has(id)) {
      orders.set(id, {
        clientOrderId: id,
        symbol: event.symbol ?? null,
        side: event.side ?? null,
        requestedUsd: event.requestedUsd ?? null,
        brokerOrderId: null,
        state: ORDER_STATES.PLANNED,
        filledUsd: 0,
        filledQuantity: 0,
        // 체결가는 평균이 필요합니다. 부분 체결이 여러 번이면 가중평균입니다.
        events: [],
      });
    }
    const order = orders.get(id);
    order.events.push(event);

    switch (event.type) {
      case "PLANNED":
        // 이미 진행된 주문에 PLANNED가 또 오면 재시작 후 재기록입니다.
        // 상태를 되돌리지 않습니다 — 되돌리면 끝난 주문을 다시 내게 됩니다.
        break;
      case "SUBMITTED":
        order.brokerOrderId = event.brokerOrderId ?? order.brokerOrderId;
        if (!isTerminal(order.state)) order.state = ORDER_STATES.SUBMITTED;
        break;
      case "FILL": {
        order.brokerOrderId = event.brokerOrderId ?? order.brokerOrderId;
        order.filledUsd += Number(event.filledUsd) || 0;
        order.filledQuantity += Number(event.filledQuantity) || 0;
        // 요청액을 사실상 다 채웠으면 완결로 봅니다. 센트 미만 잔량은 체결
        // 단위 때문에 남는 것이지 미체결이 아닙니다.
        const remaining = (Number(order.requestedUsd) || 0) - order.filledUsd;
        order.state = remaining > 0.01 ? ORDER_STATES.PARTIAL : ORDER_STATES.FILLED;
        break;
      }
      case "REJECTED":
        order.state = ORDER_STATES.REJECTED;
        order.rejectReason = event.reason ?? null;
        break;
      case "CANCELED":
        // 부분 체결 뒤 취소면 체결분은 남고 나머지가 사라집니다.
        order.state = order.filledUsd > 0 ? ORDER_STATES.PARTIAL : ORDER_STATES.CANCELED;
        order.canceled = true;
        break;
      default:
        break;
    }
  }

  return orders;
}

/**
 * 결말이 안 난 주문을 찾습니다. **다음 사이클을 돌기 전에 이것이 비어 있어야
 * 합니다.**
 *
 * 남아 있는데 새 주문을 내면 같은 매수를 두 번 하거나, 이미 팔린 것을 또 팔게
 * 됩니다. 그래서 여기 뭔가 있으면 매매를 멈추고 조회부터 합니다.
 *
 * PARTIAL도 포함합니다. 일부만 체결된 주문은 나머지가 아직 시장에 살아 있을
 * 수 있고, 그 상태로 같은 종목에 새 주문을 얹으면 의도한 것보다 많이 삽니다.
 */
export function unresolvedOrders(orders) {
  return [...orders.values()].filter((order) => !isTerminal(order.state));
}

/** 체결된 것만 모아 실제 포지션 변화를 냅니다. 의도가 아니라 사실입니다. */
export function realizedFills(orders) {
  const bySymbol = new Map();
  for (const order of orders.values()) {
    if (order.filledQuantity === 0) continue;
    const sign = order.side === "SELL" ? -1 : 1;
    const previous = bySymbol.get(order.symbol) ?? { quantity: 0, usd: 0 };
    bySymbol.set(order.symbol, {
      quantity: previous.quantity + sign * order.filledQuantity,
      usd: previous.usd + sign * order.filledUsd,
    });
  }
  return bySymbol;
}

/**
 * 장부가 생각하는 보유와 브로커가 말하는 보유를 맞춰 봅니다.
 *
 * **브로커가 진실입니다.** 우리 장부는 의도의 기록일 뿐이고, 부분 체결·거절·
 * 수동 매매·배당 재투자 같은 것은 우리가 모르는 사이에 브로커 쪽만 바꿉니다.
 *
 * 어긋나면 매매를 멈춥니다. 어긋난 채로 리밸런싱하면 잘못된 보유를 기준으로
 * 목표 비중을 계산해 오차를 키웁니다.
 */
export function reconcile(ledgerPositions, brokerPositions, { toleranceUsd = 0.05 } = {}) {
  const symbols = new Set([
    ...Object.keys(ledgerPositions ?? {}),
    ...Object.keys(brokerPositions ?? {}),
  ]);

  const differences = [];
  for (const symbol of symbols) {
    const ledger = Number(ledgerPositions?.[symbol] ?? 0);
    const broker = Number(brokerPositions?.[symbol] ?? 0);
    const gap = broker - ledger;
    if (Math.abs(gap) > toleranceUsd) {
      differences.push({ symbol, ledgerUsd: round2(ledger), brokerUsd: round2(broker), gapUsd: round2(gap) });
    }
  }

  return { matched: differences.length === 0, differences };
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
