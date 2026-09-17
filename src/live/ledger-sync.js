import { ORDER_STATES, realizedFills } from "./order-lifecycle.js";

/**
 * 실계좌를 **장부의 보유 수량**에 맞추는 주문을 계산하는 순수 함수입니다.
 *
 * ── 왜 결정이 아니라 보유를 따라가는가 (2026-09-17) ─────────────────────────
 *
 * 예전에는 PAPER 엔진이 **그 사이클에 새로 낸 결정**만 실주문으로 옮겼습니다
 * (`paper-bridge.js`). 장부는 07-14에 이미 비중을 다 채웠고 LIVE는 9/1에 켰으니,
 * 옮길 결정이 밴드를 넘는 날에만 생겼습니다. **초기 매수를 내는 주체가 없어서**
 * 9/1~9/16 실주문이 0건이었고, 장부 $64.68 대 실계좌 $19.91이 그대로 남았습니다
 * (STRATEGY.md ㉖).
 *
 * 결정을 옮기는 방식은 한 번 어긋나면 **저절로 안 돌아옵니다** — 거절 한 건,
 * 덜 체결된 한 건이 영구 차이가 됩니다. 보유를 따라가면 차이가 곧 주문이라
 * 처음 채우기와 이후 어긋남이 같은 경로로 메워집니다.
 *
 * **전략은 안 바뀝니다.** 무엇을 얼마나 들지는 여전히 장부(밴드 5%·추세 층)가
 * 정합니다. 여기서 정하는 것은 실계좌가 그것을 얼마나 빨리 따라가느냐뿐입니다.
 *
 * ── 달러가 아니라 수량 차이입니다 ───────────────────────────────────────────
 *
 * 장부와 실계좌가 같은 수량을 들고 있으면 가격이 움직여도 차이는 0입니다. 그래서
 * 가격 변동이 주문을 만들지 않습니다. 달러는 수량 차이에 지금 가격을 곱해 주문
 * 크기로 바꿀 때만 씁니다.
 *
 * ── 한도 ─────────────────────────────────────────────────────────────────
 *
 * - 매수는 1회 `maxOrderUsd`, 하루 `maxDailyBuyUsd`입니다. 장부와 같은 한도를
 *   **실계좌 원장 기준으로 따로** 셉니다. 다만 오늘 실계좌에서 판 금액만큼은 다시
 *   살 수 있습니다 — 장부의 `redeployableUsd`와 같은 규칙입니다.
 * - 매도는 크기 한도가 없습니다(위험을 줄이는 쪽). 대신 **보유의 98%까지만**
 *   냅니다. 금액 주문은 제출과 체결 사이 가격이 오르면 보유보다 많이 팔려고 해
 *   `insufficient-sellable-quantity`로 거절됩니다. 남는 잔량은 $1 미만이면 둡니다.
 * - 실계좌 관리 종목 평가액 합계는 장부 자산(`maxLiveValueUsd`)을 넘지 않습니다.
 *   장부 자산은 10만 원 상한에서 출발하므로 실계좌 노출도 같은 상한에 묶입니다.
 * - **오늘 거절된 종목·방향은 오늘 다시 내지 않습니다.** 매수 여력 부족 같은
 *   거절은 15분 뒤에도 그대로라, 막지 않으면 하루 26번 거절을 쌓습니다.
 */

/** 이 비율까지만 팝니다. 위 「한도」를 보십시오. */
export const SELL_FRACTION = 0.98;

/**
 * @param {object} input
 * @param {object} input.ledgerPositions  장부 수량 `{ VTI: 0.12, ... }`
 * @param {Map}    input.orders           `buildOrders()` 결과 — 실계좌 원장
 * @param {Map|object} input.prices       종목 → 지금 가격
 * @param {string[]} input.managedSymbols
 * @param {object} input.limits           `{ minOrderUsd, maxOrderUsd, maxDailyBuyUsd }`
 * @param {number} [input.maxLiveValueUsd] 실계좌 관리 종목 평가액 상한(장부 자산)
 * @param {Date}   input.now
 * @returns {{ intents: Array, notes: string[] }}
 */
export function planLedgerSync({
  ledgerPositions = {},
  orders = new Map(),
  prices = new Map(),
  managedSymbols = [],
  limits,
  maxLiveValueUsd = Infinity,
  now = new Date(),
}) {
  const { minOrderUsd, maxOrderUsd, maxDailyBuyUsd } = limits;
  const priceOf = (symbol) => Number(prices instanceof Map ? prices.get(symbol) : prices[symbol]);
  // **실계좌의 우리 몫은 원장의 체결 합계입니다.** 기준선(원래 있던 자산)은 빼고
  // 봅니다 — 대사가 `기준선 + 체결 = 브로커`를 이미 확인한 뒤에 여기로 옵니다.
  const fills = realizedFills(orders);
  const liveQuantity = (symbol) => Number(fills.get(symbol)?.quantity) || 0;

  const today = dayKey(now);
  const todays = [...orders.values()].filter((order) => dayKey(order.events?.[0]?.at) === today);
  const rejectedToday = new Set(
    todays
      .filter((order) => order.state === ORDER_STATES.REJECTED)
      .map((order) => `${order.symbol}:${order.side}`),
  );

  const notes = [];
  const sells = [];
  const buys = [];
  let liveValueUsd = 0;

  for (const symbol of managedSymbols) {
    const price = priceOf(symbol);
    if (!(price > 0)) {
      notes.push(`${symbol}: 가격이 없어 맞추지 않습니다`);
      continue;
    }
    const live = liveQuantity(symbol);
    liveValueUsd += live * price;
    const gapUsd = ((Number(ledgerPositions[symbol]) || 0) - live) * price;
    if (Math.abs(gapUsd) < minOrderUsd) continue;

    const side = gapUsd > 0 ? "BUY" : "SELL";
    if (rejectedToday.has(`${symbol}:${side}`)) {
      notes.push(`${symbol} ${side}: 오늘 거절돼 내일 다시 맞춥니다 (차이 $${Math.abs(gapUsd).toFixed(2)})`);
      continue;
    }
    if (side === "SELL") {
      const amountUsd = floorCents(Math.min(-gapUsd, live * price * SELL_FRACTION));
      if (amountUsd >= minOrderUsd) sells.push({ symbol, side, amountUsd });
    } else {
      buys.push({ symbol, side, gapUsd });
    }
  }

  // 매도가 먼저입니다. 위험을 줄이는 쪽이고, 판 돈이 오늘 매수 여력으로 돌아옵니다.
  sells.sort((a, b) => b.amountUsd - a.amountUsd);
  buys.sort((a, b) => b.gapUsd - a.gapUsd);

  let buyRoomUsd = Math.min(
    maxDailyBuyUsd - spentUsd(todays, "BUY") + spentUsd(todays, "SELL"),
    maxLiveValueUsd - liveValueUsd,
  );
  const buyIntents = [];
  for (const { symbol, side, gapUsd } of buys) {
    const amountUsd = floorCents(Math.min(gapUsd, maxOrderUsd, buyRoomUsd));
    if (amountUsd < minOrderUsd) {
      notes.push(`${symbol} BUY: 오늘 매수 한도를 다 써서 내일 이어 맞춥니다 (차이 $${gapUsd.toFixed(2)})`);
      continue;
    }
    buyRoomUsd -= amountUsd;
    buyIntents.push({ symbol, side, amountUsd });
  }

  return { intents: [...sells, ...buyIntents], notes };
}

/**
 * 오늘 그 방향으로 쓴 금액입니다. 체결이 끝났으면 체결액, 진행 중이면 요청액으로
 * 셉니다 — 진행 중인 주문을 0으로 세면 한도를 넘겨 냅니다. 매도는 **체결된 것만**
 * 셉니다. 아직 안 팔린 돈을 매수 여력으로 쓰면 안 됩니다.
 */
function spentUsd(orders, side) {
  let total = 0;
  for (const order of orders) {
    if (order.side !== side) continue;
    if (order.state === ORDER_STATES.REJECTED) continue;
    const settled = order.state === ORDER_STATES.FILLED || order.canceled;
    if (side === "SELL") total += Number(order.filledUsd) || 0;
    else total += settled ? Number(order.filledUsd) || 0 : Number(order.requestedUsd) || 0;
  }
  return total;
}

/** 미국 정규장은 UTC 하루 안에 들어가므로 UTC 날짜로 셉니다 — 장부와 같은 규칙입니다. */
function dayKey(at) {
  const time = new Date(at);
  return Number.isFinite(time.getTime()) ? time.toISOString().slice(0, 10) : null;
}

/**
 * 센트 미만을 버립니다. **눈금 하나 아래의 오차는 봐줍니다** — `13.6 − 16.08`은
 * `−2.48`이 아니라 `−2.4799999…`이고, 그대로 내리면 $2.47이 됩니다.
 */
function floorCents(value) {
  return Math.floor(Number(value) * 100 + 1e-6) / 100;
}
