/**
 * 슬리피지를 재는 도구입니다.
 *
 * 금액 주문은 **시장가**라 체결가를 우리가 정하지 못합니다. 백테스트는 전 구간
 * 10bp를 가정했는데 그중 수수료는 현재 0으로 확인됐으므로(2026-08-07), 남은
 * 비용은 사실상 **슬리피지와 환전**입니다. 그 둘이 10bp 안에 들어오는지가
 * 11월 병행 운용의 핵심 질문입니다.
 *
 * ── 무엇을 기준으로 재는가 ────────────────────────────────────────────────
 *
 * 기준은 **주문 직전의 중간가(mid)**입니다. 마지막 체결가가 아닙니다 — 마지막
 * 체결은 매수 체결이었을 수도 매도 체결이었을 수도 있어서, 그것을 기준으로 삼으면
 * 스프레드의 절반이 무작위로 섞여 들어옵니다.
 *
 * 그리고 비용을 **둘로 나눠** 봅니다.
 *
 *   반스프레드   (ask − bid) / 2 / mid
 *     시장가 주문이면 피할 수 없는 몫입니다. 넓은 시각(개장 직후)에 내면 커집니다.
 *
 *   스프레드 초과  (체결가 − mid) / mid − 반스프레드
 *     그 이상 밀린 몫입니다. 지연·시장 충격·주문 크기에서 옵니다.
 *
 * 나누는 이유는 **대응이 다르기 때문**입니다. 반스프레드가 크면 시간대를 바꿔야
 * 하고, 초과분이 크면 주문 크기나 방식을 봐야 합니다.
 */

/**
 * 호가 응답에서 매수·매도 최우선호가를 꺼냅니다.
 *
 * **스키마를 모르므로 방어적으로 읽습니다.** 흔한 이름을 차례로 시도하고,
 * 실패하면 `null`을 냅니다. 원본은 그대로 보관하므로(`raw`), 파서가 틀렸어도
 * 나중에 고쳐서 **과거 측정을 다시 계산**할 수 있습니다. 그래서 원본을 버리지
 * 않는 것이 파싱보다 중요합니다.
 */
export function extractQuote(payload) {
  // 후보를 하나 고르고 파싱하는 것이 아니라, **파싱이 되는 후보를 고릅니다.**
  // 응답이 `{ result: {...} }`처럼 감싸여 있으면 바깥 껍데기도 객체라서, 먼저
  // 고르면 안쪽을 영영 못 봅니다.
  const candidates = [
    payload,
    payload?.result,
    Array.isArray(payload) ? payload[0] : null,
    Array.isArray(payload?.result) ? payload.result[0] : null,
    payload?.orderbook,
    payload?.result?.orderbook,
    payload?.items?.[0],
    payload?.result?.items?.[0],
  ].filter((candidate) => candidate && typeof candidate === "object");

  for (const node of candidates) {
    const quote = readQuoteFrom(node);
    if (quote.bid !== null || quote.ask !== null) return quote;
  }
  return { bid: null, ask: null, mid: null, last: null };
}

function readQuoteFrom(node) {
  const bid = pickNumber(node, [
    "bidPrice", "bestBidPrice", "buyPrice", "bid",
  ]) ?? levelPrice(node, ["bids", "bidLevels", "buyLevels"]);
  const ask = pickNumber(node, [
    "askPrice", "bestAskPrice", "sellPrice", "ask",
  ]) ?? levelPrice(node, ["asks", "askLevels", "sellLevels"]);
  const last = pickNumber(node, ["lastPrice", "price", "close", "tradePrice"]);

  // 중간가는 나눗셈이라 부동소수 잔여가 남습니다((33.50+33.54)/2 =
  // 33.519999999999996). 그대로 두면 원장에도 그 모양으로 쌓이므로 여기서 자릅니다.
  // 6자리면 어떤 가격대에서도 호가 단위보다 훨씬 촘촘합니다.
  const mid = bid !== null && ask !== null && bid > 0 && ask > 0
    ? Math.round(((bid + ask) / 2 + Number.EPSILON) * 1e6) / 1e6
    : null;
  return { bid, ask, mid, last };
}

/**
 * 체결가와 기준 호가로 비용을 나눕니다. 값이 모자라면 `null`을 담아 **모른다는
 * 사실을 남깁니다** — 0으로 채우면 "쟀는데 0이었다"와 구분되지 않습니다.
 */
export function computeSlippage({ side, quote, filledPrice }) {
  const price = Number(filledPrice);
  const mid = Number(quote?.mid);
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);

  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(mid) || mid <= 0) {
    return { slippageBps: null, halfSpreadBps: null, beyondSpreadBps: null, reason: "기준 호가 없음" };
  }

  // 매수는 위로 밀리면 손해, 매도는 아래로 밀리면 손해입니다. 부호를 맞춰
  // **항상 양수가 손해**가 되게 합니다.
  const direction = side === "SELL" ? -1 : 1;
  const slippageBps = round2(((price - mid) / mid) * direction * 10_000);

  const halfSpreadBps = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
    ? round2(((ask - bid) / 2 / mid) * 10_000)
    : null;

  return {
    slippageBps,
    halfSpreadBps,
    beyondSpreadBps: halfSpreadBps === null ? null : round2(slippageBps - halfSpreadBps),
    reason: null,
  };
}

/**
 * 원장에 쌓인 체결들을 모아 요약합니다.
 *
 * **건수가 적으면 숫자를 내지 않습니다.** 슬리피지는 한 건마다 크게 흔들리는데,
 * 두세 건의 평균을 근거처럼 쓰면 감성 표본에서 하지 않기로 한 일을 여기서 하게
 * 됩니다. 기준을 감성과 같은 10건으로 맞춥니다.
 */
export function summarizeSlippage(measurements, { minimumSamples = 10 } = {}) {
  const usable = (measurements ?? []).filter((item) => Number.isFinite(item?.slippageBps));
  if (usable.length === 0) return { count: 0 };

  const values = usable.map((item) => item.slippageBps);
  const spreads = usable.map((item) => item.halfSpreadBps).filter(Number.isFinite);

  return {
    count: usable.length,
    enoughSamples: usable.length >= minimumSamples,
    minimumSamples,
    meanBps: round2(average(values)),
    medianBps: round2(median(values)),
    maxBps: round2(Math.max(...values)),
    minBps: round2(Math.min(...values)),
    meanHalfSpreadBps: spreads.length ? round2(average(spreads)) : null,
    // 백테스트 가정과의 대조입니다. 이것이 이 측정의 목적입니다.
    assumptionBps: 10,
  };
}

function pickNumber(node, names) {
  for (const name of names) {
    const value = Number(node?.[name]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** `bids: [{ price, quantity }, ...]` 형태에서 최우선호가를 꺼냅니다. */
function levelPrice(node, names) {
  for (const name of names) {
    const levels = node?.[name];
    if (!Array.isArray(levels) || levels.length === 0) continue;
    const value = Number(levels[0]?.price ?? levels[0]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
