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

        // **브로커가 끝났다고 하면 끝난 것입니다.** 우리 산수보다 브로커가
        // 진실입니다.
        //
        // 금액 주문은 주식 수량 단위 때문에 **항상 요청액보다 조금 적게**
        // 체결됩니다(2026-08-07 실측: $2.00 요청 → $1.99 체결). 그 잔액을
        // 미체결로 읽으면 주문이 영원히 PARTIAL로 남고, PARTIAL은 미결이므로
        // **에이전트가 영구 정지합니다.** 실제로 이번 주문은 잔액이 정확히
        // $0.01이라 간신히 통과했습니다.
        if (event.terminal === true) {
          order.state = ORDER_STATES.FILLED;
          break;
        }

        // 브로커 상태를 모르는 경우에만 금액으로 추정합니다. 센트 미만 잔량은
        // 체결 단위 때문에 남는 것이지 미체결이 아닙니다.
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
 *
 * **다만 취소된 주문은 뺍니다.** 부분 체결 뒤 취소면 상태는 PARTIAL로 남는데
 * (체결분은 실제로 있었으므로 그 이름이 맞습니다), **취소된 주문에는 더 일어날
 * 일이 없습니다.** 그것을 미결로 세면 조회로도 못 풉니다 — `eventsFromLookup`이
 * "조회 결과 없음"을 닫으려고 내는 것이 바로 CANCELED라서, 닫으려는 사건이
 * 도리어 미결을 영속시킵니다. 2026-08-07 주문 두 건이 그 상태로 남아 있었습니다.
 */
export function unresolvedOrders(orders) {
  return [...orders.values()].filter((order) => !isTerminal(order.state) && !order.canceled);
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
 * 수동 매매 같은 것은 우리가 모르는 사이에 브로커 쪽만 바꿉니다.
 *
 * 어긋나면 매매를 멈춥니다. 어긋난 채로 리밸런싱하면 잘못된 보유를 기준으로
 * 목표 비중을 계산해 오차를 키웁니다.
 *
 * **수량으로 비교하는 것이 정확합니다.** 평가액은 어느 시점 가격을 쓰느냐에
 * 따라 달라져 없는 불일치를 만듭니다. 단위가 바뀌면 `tolerance`도 함께 바꿔야
 * 합니다 — 수량 0.05는 VTI 기준 15달러라 사실상 검사를 끄는 값입니다.
 *
 * **배당은 여기 안 걸립니다.** 토스에는 DRIP(배당 자동재투자)이 없어서
 * (2026-08-27 확인) 배당이 주식으로 안 돌아오고, 수량이 안 변하니 이 검사는
 * 통과합니다. 배당이 바꾸는 것은 계좌 **현금**인데 우리는 그것을 조회하지
 * 않습니다 — 그래서 그 돈은 장부 밖에 고입니다. STRATEGY.md §2의 배당 항목을
 * 보십시오. 이 함수를 고쳐서 될 일이 아닙니다.
 */
export function reconcile(ledgerPositions, brokerPositions, { tolerance = 0.05 } = {}) {
  const symbols = new Set([
    ...Object.keys(ledgerPositions ?? {}),
    ...Object.keys(brokerPositions ?? {}),
  ]);

  const differences = [];
  for (const symbol of symbols) {
    const ledger = Number(ledgerPositions?.[symbol] ?? 0);
    const broker = Number(brokerPositions?.[symbol] ?? 0);
    const gap = broker - ledger;
    if (Math.abs(gap) > tolerance) {
      differences.push({ symbol, ledgerUsd: round2(ledger), brokerUsd: round2(broker), gapUsd: round2(gap) });
    }
  }

  return { matched: differences.length === 0, differences };
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
