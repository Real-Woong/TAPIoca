/**
 * 토스증권 Open API 호출 제한을 지키는 장치입니다.
 *
 * 우리 사이클은 15분마다 오고 주문은 한 번에 하나라 평상시에는 제한에 닿을 일이
 * 없습니다. **문제는 재시작 복구입니다** — 미결 주문이 여럿이면 조회가 연달아
 * 나가고, 그때 429를 맞으면 복구가 실패한 것처럼 보입니다. 상태를 모르는 채로
 * 다음 사이클이 멈추므로 실질적인 정지입니다.
 *
 * 문서에 적힌 값(2026-08-07 확인)은 기본값으로만 씁니다. **실제 기준은 응답
 * 헤더의 `X-RateLimit-Limit`입니다** — 운영 중 바뀔 수 있고, 그때 우리 상수는
 * 낡은 값이 됩니다.
 */

/**
 * 가이드의 Rate Limits 표를 그대로 옮긴 기본값입니다(2026-08-07).
 * 응답 헤더 `X-RateLimit-Limit`이 오면 그쪽으로 갱신됩니다.
 *
 * 이름은 우리 쪽 호출 종류이고 괄호가 가이드의 그룹명입니다.
 */
export const DEFAULT_LIMITS = Object.freeze({
  auth: 5,          // AUTH
  order: 10,        // ORDER — 주문 생성·정정·취소
  orderQuery: 5,    // ORDER_HISTORY — 주문 목록·상세
  orderable: 6,     // ORDER_INFO — 매수가능금액·매도가능수량·수수료
  holdings: 5,      // ASSET
  accounts: 1,      // ACCOUNT
  marketInfo: 3,    // MARKET_INFO — 환율·장 운영 시간
});

/**
 * 한국시간 09:00~09:10에 좁아지는 것은 **`ORDER_INFO` 하나뿐**입니다(6 → 3).
 * `ORDER`는 피크에도 10/s 그대로이고 `ORDER_HISTORY`에는 피크 항목이 없습니다.
 *
 * 참고로 **우리 매매 시간과는 겹치지 않습니다.** 미국 정규장은 한국시간으로
 * 밤 22:30~새벽 06:00 구간이고, 금액 주문은 정규장에만 되기 때문입니다.
 * 그래도 넣어 두는 이유는 이 사실이 바뀌었을 때(써머타임·제도 변경) 조용히
 * 틀리지 않기 위해서입니다.
 */
export const NARROW_WINDOW = Object.freeze({
  categories: ["orderable"],
  limitPerSecond: 3,
  startMinuteKst: 9 * 60,
  endMinuteKst: 9 * 60 + 10,
});

export function isNarrowWindow(date) {
  // UTC+9로 한국시간을 만듭니다. 한국은 써머타임이 없어 고정 오프셋이 맞습니다.
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const minute = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return minute >= NARROW_WINDOW.startMinuteKst && minute < NARROW_WINDOW.endMinuteKst;
}

/**
 * @param {object} options
 * @param {Function} options.now    시간을 주입해 테스트에서 기다리지 않게 합니다.
 * @param {Function} options.sleep  실제로 기다리는 함수. 테스트에서는 시계를 돌립니다.
 */
export function createRateLimiter({
  limits = DEFAULT_LIMITS,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const effective = { ...limits };
  // 카테고리별 최근 1초 안의 호출 시각입니다.
  const recent = new Map();
  // 429를 맞으면 그 시각까지 아무것도 내보내지 않습니다.
  let blockedUntil = 0;

  const limitFor = (category, at) => {
    const base = effective[category] ?? Infinity;
    if (NARROW_WINDOW.categories.includes(category) && isNarrowWindow(at)) {
      return Math.min(base, NARROW_WINDOW.limitPerSecond);
    }
    return base;
  };

  return {
    /** 지금 이 카테고리를 호출해도 되는 시점까지 기다립니다. */
    async acquire(category) {
      for (;;) {
        const at = now();
        const time = at.getTime();

        if (time < blockedUntil) {
          await sleep(blockedUntil - time);
          continue;
        }

        const limit = limitFor(category, at);
        if (!Number.isFinite(limit)) return;

        const window = (recent.get(category) ?? []).filter((stamp) => time - stamp < 1000);
        if (window.length < limit) {
          window.push(time);
          recent.set(category, window);
          return;
        }

        // 가장 오래된 호출이 1초를 벗어날 때까지만 기다리면 됩니다.
        await sleep(1000 - (time - window[0]) + 1);
      }
    },

    /**
     * 응답을 보고 실제 제한을 배웁니다.
     *
     * `X-RateLimit-Limit`이 오면 우리 상수보다 그쪽을 믿습니다. 429면
     * `Retry-After`만큼 전면 차단합니다 — 카테고리별이 아니라 전면인 이유는,
     * 한도를 넘긴 상태에서 다른 종류를 계속 두드리면 차단이 길어질 수 있기
     * 때문입니다.
     */
    observeResponse(category, { status, headers } = {}) {
      const get = (name) => headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];

      const declared = Number(get("X-RateLimit-Limit"));
      if (Number.isFinite(declared) && declared > 0) effective[category] = declared;

      if (status === 429) {
        const retryAfter = Number(get("Retry-After"));
        // 헤더가 없으면 1초를 씁니다. 모를 때 0으로 두면 곧바로 다시 맞습니다.
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000;
        blockedUntil = now().getTime() + waitMs;
        return { blockedForMs: waitMs };
      }
      return { blockedForMs: 0 };
    },

    /** 진단용입니다. 지금 적용 중인 한도를 봅니다. */
    currentLimits() {
      return { ...effective };
    },
  };
}
