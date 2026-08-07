/**
 * 테스트용 가짜 브로커입니다. **실패 모드를 일부러 낼 수 있게** 만들었습니다.
 *
 * 실거래에서 다치는 곳은 정상 경로가 아닙니다. 주문이 거절되고, 절반만 체결되고,
 * 응답이 오다 말고, 그 사이 프로세스가 죽는 곳에서 다칩니다. 그런 상황은 실제
 * 브로커로는 마음대로 만들 수 없으므로 여기서 만듭니다.
 *
 * 계약(`broker-contract.js`)을 그대로 지키므로, 여기서 통과한 실행 로직은
 * 실제 어댑터에서도 같은 모양으로 동작합니다.
 */
export function createFakeBroker({
  positions = {},
  // 주문마다 무엇을 할지 정합니다. 배열이면 순서대로 하나씩 꺼내 씁니다.
  //   { fill: 1 }          전량 체결
  //   { fill: 0.5 }        절반만 체결
  //   { reject: "사유" }   거절
  //   { timeout: true }    응답 없음(예외). 브로커 쪽에는 접수됐을 수도 있다
  //   { accept: true }     접수만 하고 체결은 나중에
  //   { conflict: true }   같은 아이디에 다른 내용 (idempotency-key-conflict)
  //   { inProgress: true } 같은 주문이 처리 중 (request-in-progress)
  behaviors = [],
  price = 100,
} = {}) {
  const orders = new Map();
  const queue = [...behaviors];
  let sequence = 0;

  const nextBehavior = () => (queue.length > 0 ? queue.shift() : { fill: 1 });

  return {
    /** 접수된 주문을 테스트에서 들여다보기 위한 창입니다. 계약 밖입니다. */
    _orders: orders,

    async submitOrder({ clientOrderId, symbol, side, amountUsd }) {
      const behavior = nextBehavior();
      sequence += 1;
      const brokerOrderId = `BRK-${sequence}`;

      // 토스증권의 멱등 규약을 흉내 냅니다. 둘 다 "이미 보냈다"는 증거이므로
      // 재제출하면 안 되고 조회로 결말을 지어야 합니다.
      if (behavior.conflict || behavior.inProgress) {
        const error = new Error(
          behavior.conflict ? "같은 아이디에 다른 내용이 접수돼 있습니다" : "같은 주문을 처리 중입니다",
        );
        error.code = behavior.conflict ? "idempotency-key-conflict" : "request-in-progress";
        // 브로커에는 남아 있습니다 - 그래서 조회하면 나옵니다.
        if (!orders.has(clientOrderId)) {
          orders.set(clientOrderId, {
            clientOrderId, brokerOrderId: `BRK-${sequence + 1}`, symbol, side, amountUsd,
            status: "OPEN", filledUsd: 0, filledQuantity: 0,
          });
        }
        throw error;
      }

      // 같은 아이디로 같은 내용이 다시 오면 새 주문을 만들지 않고 기존 것을 돌려줍니다.
      const existing = orders.get(clientOrderId);
      if (existing && existing.amountUsd === amountUsd) return { ...existing, deduplicated: true };

      if (behavior.timeout) {
        // **응답을 못 받았지만 브로커에는 접수됐다.** 이것이 가장 위험한 경우다.
        // 우리 쪽에는 예외만 남고, 조회하지 않으면 낸 줄 모른다.
        orders.set(clientOrderId, {
          clientOrderId, brokerOrderId, symbol, side, amountUsd,
          status: "OPEN", filledUsd: 0, filledQuantity: 0,
        });
        throw new Error("응답 시간 초과");
      }

      if (behavior.reject) {
        orders.set(clientOrderId, {
          clientOrderId, brokerOrderId, symbol, side, amountUsd,
          status: "REJECTED", reason: behavior.reject, filledUsd: 0, filledQuantity: 0,
        });
        return { clientOrderId, brokerOrderId, status: "REJECTED", reason: behavior.reject };
      }

      const ratio = behavior.accept ? 0 : (behavior.fill ?? 1);
      const filledUsd = round2(amountUsd * ratio);
      const record = {
        clientOrderId, brokerOrderId, symbol, side, amountUsd,
        status: ratio >= 1 ? "FILLED" : ratio > 0 ? "PARTIAL" : "OPEN",
        filledUsd,
        filledQuantity: filledUsd / price,
        filledPrice: price,
        fees: round2(filledUsd * 0.001),
      };
      orders.set(clientOrderId, record);
      applyFill(positions, record);
      return { ...record };
    },

    async getOrder(clientOrderId) {
      // **없으면 null이다.** 오류를 던지면 "안 냈다"와 "조회에 실패했다"가
      // 구분되지 않고, 그 둘은 정반대 대응을 요구한다.
      return orders.has(clientOrderId) ? { ...orders.get(clientOrderId) } : null;
    },

    async listOpenOrders() {
      return [...orders.values()]
        .filter((order) => order.status === "OPEN" || order.status === "PARTIAL")
        .map((order) => ({ ...order }));
    },

    async getPositions() {
      return { ...positions };
    },

    async cancelOrder(clientOrderId) {
      const order = orders.get(clientOrderId);
      if (!order || order.status === "FILLED") return { canceled: false };
      order.status = order.filledUsd > 0 ? "PARTIAL" : "CANCELED";
      return { canceled: true, filledUsd: order.filledUsd };
    },
  };
}

function applyFill(positions, record) {
  if (record.filledUsd === 0) return;
  const sign = record.side === "SELL" ? -1 : 1;
  positions[record.symbol] = round2((positions[record.symbol] ?? 0) + sign * record.filledUsd);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
