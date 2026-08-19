/**
 * PAPER 엔진이 낸 **의도**를 실주문 의도로 옮깁니다.
 *
 * 두 모양이 미묘하게 다릅니다. PAPER 결정은 `{ symbol, action, reason, amountUsd }`이고
 * 실거래 사이클은 `{ symbol, side, amountUsd }`를 받습니다. 그리고 **PAPER 결정에는
 * 주문이 아닌 것이 섞여 있습니다** — `RISK_ALERT`, `PAUSE_BUY`는 알림이지 주문이
 * 아닙니다. 그것을 그대로 넘기면 `side: "RISK_ALERT"`인 주문이 브로커로 갑니다.
 *
 * **버린 것은 돌려줍니다.** 조용히 거르면 "왜 이 결정이 주문이 안 됐는가"를
 * 나중에 되짚을 수 없습니다.
 */

/** 주문이 되는 결정입니다. 이 밖의 `action`은 알림이라 주문으로 옮기지 않습니다. */
export const ORDER_ACTIONS = Object.freeze(["BUY", "SELL"]);

/**
 * 브로커에 보낼 수 있는 최소 금액입니다.
 *
 * `toss-broker`가 금액을 `toFixed(2)`로 센트에 고정하므로, 1센트 미만은 문자열
 * `"0.00"`이 되어 **$0짜리 주문**이 나갑니다. 정책의 `MIN_ORDER_USD`(기본 $1)와는
 * 다른 층의 바닥입니다 — 그쪽은 "낼 가치가 있는가"이고 이쪽은 "낼 수 있는가"입니다.
 */
export const BROKER_MIN_USD = 0.01;

export function toOrderIntents(decisions = []) {
  const intents = [];
  const dropped = [];

  for (const decision of decisions) {
    const { symbol, action, amountUsd } = decision ?? {};
    if (!ORDER_ACTIONS.includes(action)) {
      dropped.push({ ...decision, why: `주문이 아닌 결정입니다 (${action})` });
      continue;
    }
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
      dropped.push({ ...decision, why: `금액이 없습니다 (${amountUsd})` });
      continue;
    }
    if (amount < BROKER_MIN_USD) {
      // 내봐야 "0.00"으로 나갑니다. 호출 한도만 쓰고 거절당합니다.
      dropped.push({ ...decision, why: `$${amount} 는 브로커 최소 단위 미만입니다` });
      continue;
    }
    intents.push({ symbol, side: action, amountUsd: amount });
  }

  return { intents, dropped };
}
