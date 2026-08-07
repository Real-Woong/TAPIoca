import { createRateLimiter } from "./rate-limiter.js";
import { normalizeTossOrder } from "./toss-order-status.js";

/**
 * 토스증권 Open API 주문 어댑터입니다. `broker-contract.js`의 계약을 지킵니다.
 *
 * 가짜 브로커와 **같은 계약 테스트를 통과**해야 합니다. 그래야 테스트에서 확인한
 * 실행 로직이 실거래에서도 같은 모양으로 돕니다.
 *
 * ── 이 어댑터가 안고 있는 제약 두 가지 ────────────────────────────────────
 *
 * **① 주문 상세 응답에 `clientOrderId`가 없습니다.**
 * 생성 응답에만 나옵니다. 그래서 우리 아이디로 곧장 조회할 수 없고,
 * `clientOrderId → orderId` 대응을 **우리가** 들고 있어야 합니다. 그 대응은
 * 주문 원장의 SUBMITTED 이벤트에 남으므로 `lookupBrokerOrderId`로 주입받습니다.
 *
 * **② 멱등키가 10분만 유효합니다.**
 * 응답을 못 받아 orderId를 모르면, 복구 방법은 같은 clientOrderId로 재전송해
 * 이전 결과를 돌려받는 것뿐입니다. 그런데 **10분이 지나면 재전송이 새 주문이
 * 됩니다.** 우리 사이클은 15분이라, 10분을 넘겨 재시작하면 재전송이 곧바로
 * 중복 매수입니다.
 *
 * 그래서 복구를 시간으로 가릅니다.
 *   10분 이내  → 멱등 재전송으로 이전 결과를 회수한다 (안전)
 *   10분 초과  → **재전송하지 않는다.** 미결 목록에서 대조하고, 애매하면 멈춘다
 */

const DEFAULT_BASE_URL = "https://openapi.tossinvest.com";

/** 토스가 clientOrderId를 멱등키로 유지하는 시간입니다. */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

/**
 * 지금 멱등 재전송이 안전한지 판단합니다.
 *
 * **경계에서는 안전한 쪽으로 넘어집니다.** 창이 닫히기 30초 전부터는 안 된다고
 * 답합니다 — 판단하고 요청이 나가는 사이에 창이 닫힐 수 있고, 그 한 번이
 * 중복 매수이기 때문입니다.
 */
export function canReplaySafely(plannedAt, now = new Date(), marginMs = 30_000) {
  const planned = new Date(plannedAt).getTime();
  if (!Number.isFinite(planned)) return false;
  return now.getTime() - planned < IDEMPOTENCY_WINDOW_MS - marginMs;
}

export class TossOrderError extends Error {
  constructor({ code, message, requestId, data, status }) {
    super(message ?? `주문 API 오류 (HTTP ${status})`);
    this.name = "TossOrderError";
    this.code = code ?? null;
    this.requestId = requestId ?? null;
    this.data = data ?? null;
    this.httpStatus = status ?? null;
  }
}

export function createTossBroker({
  // **정적 토큰이 아니라 함수를 받습니다.** 토큰은 만료되는데 우리는 15분마다
  // 몇 달을 도므로, 고정된 문자열을 들고 있으면 반드시 만료에 걸립니다.
  // 기존 `toss-client.js`가 이미 갱신을 관리하므로 그 쪽을 그대로 물립니다.
  getAccessToken,
  accountSeq,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  rateLimiter = createRateLimiter(),
  // clientOrderId → orderId. 주문 원장에서 읽어 넣습니다(②의 이유).
  lookupBrokerOrderId = async () => null,
  now = () => new Date(),
} = {}) {
  if (typeof getAccessToken !== "function") {
    throw new Error("getAccessToken(토큰을 돌려주는 함수)이 필요합니다.");
  }
  if (!accountSeq) throw new Error("accountSeq가 필요합니다.");

  async function request(category, path, { method = "GET", body } = {}) {
    await rateLimiter.acquire(category);
    // 매 호출마다 물어봅니다. 클라이언트가 만료 전에 갱신해 돌려줍니다.
    const token = await getAccessToken();

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-tossinvest-account": String(accountSeq),
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });

    rateLimiter.observeResponse(category, { status: response.status, headers: response.headers });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new TossOrderError({ ...error, status: response.status });
    }
    return payload?.result ?? null;
  }

  return {
    async submitOrder({ clientOrderId, symbol, side, amountUsd }) {
      const result = await request("order", "/api/v1/orders", {
        method: "POST",
        body: {
          clientOrderId,
          symbol,
          side,
          // 금액 주문은 US + MARKET 조합만 됩니다.
          orderType: "MARKET",
          // 금액은 문자열로 보냅니다. 부동소수 표기가 섞이지 않게 센트로 고정합니다.
          orderAmount: Number(amountUsd).toFixed(2),
        },
      });

      return {
        clientOrderId: result?.clientOrderId ?? clientOrderId,
        brokerOrderId: result?.orderId ?? null,
        // 생성 응답에는 상태가 없습니다. 접수만 확인된 상태입니다.
        status: "SUBMITTED",
      };
    },

    /**
     * @param {string} clientOrderId
     * @param {object} [hint] orderId를 모를 때 미결 목록에서 대조할 단서입니다.
     *   `{ symbol, side, amountUsd }`. 없으면 대조하지 않고 null을 냅니다.
     */
    async getOrder(clientOrderId, hint = null) {
      const brokerOrderId = await lookupBrokerOrderId(clientOrderId);

      if (brokerOrderId) {
        try {
          const result = await request("orderQuery", `/api/v1/orders/${encodeURIComponent(brokerOrderId)}`);
          return normalizeTossOrder(result);
        } catch (error) {
          // 없는 주문은 404입니다. "안 냈다"는 확실한 사실이므로 null입니다.
          if (error.httpStatus === 404) return null;
          throw error;
        }
      }

      // orderId를 모릅니다. 단서가 없으면 대조할 방법이 없습니다.
      if (!hint) return null;
      return findOpenOrderByHint(this, hint);
    },

    async listOpenOrders() {
      // OPEN은 PENDING·PARTIAL_FILLED·PENDING_CANCEL·PENDING_REPLACE를 모두 냅니다.
      // 페이지네이션 없이 전량 반환되므로 재시작 복구에 그대로 씁니다.
      const result = await request("orderQuery", "/api/v1/orders?status=OPEN");
      return (result?.orders ?? []).map(normalizeTossOrder);
    },

    /**
     * 종목별 **보유 수량**을 냅니다. 평가액이 아닙니다.
     *
     * 대사를 수량으로 하는 편이 정확합니다. 평가액은 어느 시점 가격을 쓰느냐에
     * 따라 달라져, 실제로는 맞는데 어긋난 것처럼 보이는 경우를 만듭니다.
     * 수량은 그런 여지가 없습니다.
     */
    async getPositions() {
      const result = await request("holdings", "/api/v1/holdings");
      const positions = {};
      for (const item of result?.items ?? []) {
        if (!item?.symbol) continue;
        positions[item.symbol] = Number(item.quantity ?? 0);
      }
      return positions;
    },

    async cancelOrder(clientOrderId) {
      const brokerOrderId = await lookupBrokerOrderId(clientOrderId);
      // orderId를 모르면 취소할 수 없습니다. **성공으로 보고 넘어가면 안 됩니다** —
      // 주문이 살아 있는 채로 취소됐다고 착각하게 됩니다.
      if (!brokerOrderId) {
        return { canceled: false, reason: "주문번호를 몰라 취소할 수 없습니다." };
      }
      try {
        await request("order", `/api/v1/orders/${encodeURIComponent(brokerOrderId)}/cancel`, {
          method: "POST",
        });
        return { canceled: true };
      } catch (error) {
        return { canceled: false, reason: error.message, code: error.code };
      }
    },
  };
}

/**
 * 미결 목록에서 단서로 주문을 찾습니다. **하나만 맞을 때에만 인정합니다.**
 *
 * 둘 이상 맞으면 어느 것이 우리 것인지 가릴 수 없습니다. 그때 아무거나 고르면
 * 남의 주문(수동 매매·이전 배포)을 우리 것으로 착각하게 되므로, 애매하면
 * 못 찾은 것으로 답해 상위에서 멈추게 합니다. `execution-plan.js`가 미결 주문을
 * 보고 매매를 멈추므로 그것이 안전한 결말입니다.
 */
async function findOpenOrderByHint(broker, { symbol, side, amountUsd }) {
  const open = await broker.listOpenOrders();
  const matches = open.filter((order) =>
    order.symbol === symbol
    && order.side === side
    && (amountUsd === undefined || nearlyEqual(order.orderAmountUsd, amountUsd)));

  return matches.length === 1 ? matches[0] : null;
}

function nearlyEqual(a, b) {
  if (a === null || b === null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.01;
}
