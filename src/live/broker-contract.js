/**
 * 브로커가 **반드시** 제공해야 하는 것들입니다.
 *
 * 이 파일이 존재하는 이유는 하나입니다 — Toss든 다른 곳이든, 주문 API 문서를
 * 받았을 때 **실거래가 성립하는지 아닌지를 눈대중이 아니라 목록으로 판정**하기
 * 위해서입니다. 하나라도 없으면 그 브로커로는 이 시스템을 안전하게 돌릴 수
 * 없고, 그것은 코드를 더 써서 해결되는 문제가 아닙니다.
 *
 * 각 항목 뒤에 **없으면 무슨 일이 일어나는지**를 적어 둡니다. 그게 없으면
 * "있으면 좋은 것"과 "없으면 안 되는 것"이 섞입니다.
 */

export const BROKER_REQUIREMENTS = Object.freeze([
  {
    key: "submitOrder",
    what: "주문 제출. 우리가 만든 clientOrderId를 함께 넘길 수 있어야 한다",
    whyRequired:
      "아이디를 브로커가 만들어 주면 응답을 받아야만 알 수 있는데, 응답을 못 받는 " +
      "상황(타임아웃·크래시)이 바로 대비해야 하는 상황이다. 그때 조회할 열쇠가 없으면 " +
      "냈는지 안 냈는지 확인할 방법이 없고, 확인 없이 재시도하면 같은 매수를 두 번 한다.",
  },
  {
    key: "getOrder",
    what: "clientOrderId로 주문 하나를 조회. 없으면 '없음'을 명확히 답해야 한다",
    whyRequired:
      "재시작 후 PLANNED로 남은 주문의 결말을 짓는 유일한 방법이다. " +
      "'없음'과 '오류'가 구분되지 않으면 안 낸 주문을 냈다고 오해하거나 그 반대가 된다.",
  },
  {
    key: "listOpenOrders",
    what: "미체결 주문 목록",
    whyRequired:
      "우리 로그에 없는 주문이 살아 있을 수 있다(수동 주문·이전 배포의 잔재). " +
      "그 상태로 리밸런싱하면 의도한 것보다 많이 산다.",
  },
  {
    key: "getPositions",
    what: "현재 보유 수량·평가액",
    whyRequired:
      "대사의 기준이다. 브로커가 진실이고 우리 장부는 의도의 기록일 뿐이다. " +
      "부분 체결·수동 매매·배당 재투자는 우리가 모르는 사이에 브로커 쪽만 바꾼다.",
  },
  {
    key: "cancelOrder",
    what: "미체결 주문 취소",
    whyRequired:
      "긴급 중지가 실효를 가지려면 이미 낸 주문을 거둘 수 있어야 한다. " +
      "취소가 없으면 '멈춤'이 '새 주문만 안 냄'에 그친다.",
  },
]);

/** 체결 보고에 반드시 들어와야 하는 값들입니다. */
export const FILL_REQUIREMENTS = Object.freeze([
  {
    key: "filledQuantity",
    whyRequired: "부분 체결을 수량으로 알아야 남은 잔량을 계산할 수 있다.",
  },
  {
    key: "filledPrice",
    whyRequired:
      "체결가를 모르면 실제 비용을 모른다. 백테스트가 가정한 10bp가 맞는지 " +
      "확인하는 것이 병행 운용의 목적인데, 그 확인이 불가능해진다.",
  },
  {
    key: "fees",
    whyRequired:
      "수수료와 환전 비용이 분리돼 오지 않으면 실측 비용을 가정과 비교할 수 없다. " +
      "합산으로만 온다면 그 사실을 알고 있어야 한다.",
  },
]);

/**
 * 브로커 구현이 계약을 지키는지 확인합니다. 가짜 브로커와 실제 어댑터 모두
 * 같은 검사를 통과해야 합니다 — 그래야 테스트에서 통과한 것이 실거래에서도
 * 통과합니다.
 */
export function assertBrokerContract(broker) {
  const missing = BROKER_REQUIREMENTS
    .filter((requirement) => typeof broker?.[requirement.key] !== "function")
    .map((requirement) => requirement.key);

  if (missing.length > 0) {
    throw new Error(
      `브로커가 필수 기능을 제공하지 않습니다: ${missing.join(", ")}\n` +
        missing
          .map((key) => {
            const requirement = BROKER_REQUIREMENTS.find((item) => item.key === key);
            return `  · ${key} — ${requirement.what}\n    없으면: ${requirement.whyRequired}`;
          })
          .join("\n"),
    );
  }
  return true;
}
