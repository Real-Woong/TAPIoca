import { summarizeHoldings } from "../live/cost-basis.js";
import { summarizePaperState } from "../paper/paper-engine.js";

/**
 * 하루치 상태를 사람이 읽는 한 통의 메시지로 만듭니다.
 *
 * **손익·보유·성과는 PAPER 장부입니다.** 두 장부를 나란히 굴리는 것이 전환의
 * 목적이라(실행 비용을 그 차이로 재려고), 그 숫자가 보여 주는 것은 "신호가
 * 무엇을 하려 했는가"입니다.
 *
 * **그러나 LIVE에서는 실계좌 보유를 함께 적습니다(2026-09-12).** 그전까지는
 * 계좌를 아예 조회하지 않았고, `위 손익·보유는 PAPER 장부의 숫자입니다` 한
 * 줄에 기대고 있었습니다. 그 줄은 **읽는 사람이 차이를 이미 알 때만** 작동합니다.
 * 실제로 그날 장부는 $65.62를 찍고 있었고 계좌의 관리 3종목은 $20.13이었습니다
 * — 8월 probe 잔해뿐이었습니다. 라벨이 아니라 숫자를 나란히 적어야 보입니다.
 *
 * **그래서 모드를 반드시 함께 적습니다.** 2026-09-02까지 제목과 마지막 줄이
 * `PAPER`로 못 박혀 있었습니다. 9/1에 실거래를 켠 뒤에도 보고서는 여전히
 * "PAPER 모드 — 실제 주문 없음"이라고 적었고, 그날은 주문이 0건이라 우연히
 * 참이었을 뿐입니다. **실주문이 한 건이라도 나가는 날 그 줄은 거짓이 됩니다** —
 * 매일 아침 이것만 읽는 사람에게 돈이 움직인 날 "실제 주문 없음"이라고
 * 말하게 됩니다. 진입점이 정책을 읽어 `live`를 넘기고, 여기서 그 사실을 적습니다.
 *
 * @param {object|null} live LIVE일 때만 채웁니다. `{ orders, unresolvedCount }`
 *   또는 원장을 못 읽었으면 `{ error }`. PAPER면 null입니다.
 * @param {object|null} account 실계좌 보유. `{ positions, at }` 또는 조회에
 *   실패했으면 `{ error }`. LIVE일 때만 채웁니다.
 * @param {object|null} fx 오늘 환율. `{ rate, at }` 또는 조회에 실패했으면
 *   `{ error }`. PAPER·LIVE 둘 다 채웁니다 — 원금이 원화인 것은 모드와 무관합니다.
 */
export function formatDailyReport(
  state,
  tradingDate,
  { dateForTrade, live = null, account = null, fx = null, now = new Date() } = {},
) {
  // 저장된 마지막 가격을 기준으로 가상 자산을 요약합니다.
  // 실제 계좌의 **예수금**은 여전히 포함하지 않습니다. 보유 수량만 따로 적습니다
  // (`formatAccountLines`) — 대사가 수량으로 도는 것과 같은 이유입니다.
  const summary = summarizePaperState(state);
  const toTradingDate = dateForTrade ?? ((date) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date));
  // Oracle 서버의 UTC 날짜가 아닌 뉴욕 거래일을 기준으로 오늘 거래를 골라냅니다.
  const todaysTrades = state.trades.filter(
    (trade) => toTradingDate(new Date(trade.executedAt)) === tradingDate,
  );
  const positionLines = summary.positions.length
    ? summary.positions.map((position) =>
        `• ${position.symbol}: $${position.marketValueUsd.toFixed(2)} ` +
        `(손익 ${signedUsd(position.unrealizedPnlUsd)})`,
      )
    : ["• 없음"];
  const tradeLines = todaysTrades.length
    ? todaysTrades.map((trade) =>
        `• ${trade.side} ${trade.symbol}: $${trade.amountUsd.toFixed(2)} (${trade.reason})`,
      )
    : ["• 없음"];
  const macroLines = formatMacroLines(state.macro);

  return [
    `📊 Toss ETF ${live ? "LIVE" : "PAPER"} 일일 보고서`,
    `거래일(뉴욕): ${tradingDate}`,
    "",
    `초기 원금: ${summary.fundingKrw.toLocaleString("ko-KR")}원 ($${summary.fundedUsd.toFixed(2)})`,
    `현재 총자산: $${summary.equityUsd.toFixed(2)}`,
    `현금: $${summary.cashUsd.toFixed(2)}`,
    `ETF 평가액: $${summary.marketValueUsd.toFixed(2)}`,
    `누적손익(${sinceLabel(state.createdAt)}): ${signedUsd(summary.totalPnlUsd)} (${summary.returnPct}%)`,
    `실현손익: ${signedUsd(summary.realizedPnlUsd)}`,
    `미실현손익: ${signedUsd(summary.unrealizedPnlUsd)}`,
    ...(summary.feesUsd ? [`누적 거래비용: -$${summary.feesUsd.toFixed(2)}`] : []),
    ...formatKrwLines(state, summary, fx),
    // **기준선마다 시작일이 다릅니다.** 지갑은 자금 투입일부터, VTI 기준선과
    // 정책믹스 기준선은 각자 개설일부터입니다. 그래서 시작일을 함께 찍고,
    // 초과성과는 그 기준선이 열린 날부터의 지갑 손익에서만 뺍니다.
    ...(summary.benchmark
      ? [
          `벤치마크(${summary.benchmark.symbol} 매수후보유 · ${sinceLabel(summary.benchmark.startedAt)}): ` +
            `${signedUsd(summary.benchmark.pnlUsd)} (${summary.benchmark.returnPct}%)`,
          alphaLine("초과성과(alpha)", summary.alphaWindow, summary.benchmark.startedAt),
        ]
      : []),
    // 위험을 맞춘 두 번째 기준선입니다. VTI 100%와만 비교하면 "현금을 들고 있어서"와
    // "타이밍이 틀려서"가 한 숫자에 섞입니다. 같은 종목·같은 비중을 신호 없이 들고
    // 있었을 때와 비교해야 신호 레이어의 순수한 성적이 보입니다.
    ...(summary.policyBenchmark
      ? [
          `정책믹스(${formatMix(summary.policyBenchmark.mix)} 고정 · ` +
            `${sinceLabel(summary.policyBenchmark.startedAt)}): ` +
            `${signedUsd(summary.policyBenchmark.pnlUsd)} ` +
            `(${summary.policyBenchmark.returnPct}%)`,
          alphaLine("└ 신호 초과성과", summary.policyAlphaWindow, summary.policyBenchmark.startedAt),
        ]
      : []),
    `누적 거래: ${summary.tradeCount}건`,
    ...cycleFreshnessLines(state, now),
    // 손실 한도는 매매를 멈추지 않고 알리기만 합니다. 자동 중단은 폭락 중에
    // 위험관리를 꺼버려 오히려 낙폭을 키웠습니다. 대응은 사람이 판단합니다.
    ...(state.risk?.lastCheck?.alert
      ? [
          `⚠️ 손실 경고: ${formatRiskReason(state.risk.lastCheck.reason)} ` +
            `(누적 ${signedUsd(state.risk.lastCheck.totalPnlUsd)}, ` +
            `당일 ${signedUsd(state.risk.lastCheck.dailyPnlUsd)}) — 매매는 계속합니다`,
        ]
      : []),
    ...macroLines,
    "",
    "보유 ETF (장부)",
    ...positionLines,
    ...(account ? ["", "실계좌 보유 (토스)", ...formatAccountLines(account, state, summary)] : []),
    ...formatAccountPnlLines(account, state),
    "",
    "오늘의 가상 거래",
    ...tradeLines,
    ...(live ? ["", "오늘의 실주문", ...formatLiveLines(live)] : []),
    "",
    live
      ? "LIVE 모드 — 실제 주문이 나갑니다. 손익·성과는 PAPER 장부이고, 계좌는 «실계좌 보유» 칸입니다"
      : "PAPER 모드 — 실제 주문 없음",
  ].join("\n");
}

/**
 * **실제 계좌에 지금 무엇이 있는가**를 적습니다. 관리 종목만 봅니다 — 계좌에는
 * 사장님이 손수 산 것이 함께 있고, 그것은 이 시스템의 것이 아닙니다.
 *
 * **차이가 나면 차이를 적습니다.** 2026-09-17부터 LIVE는 매 사이클 이 차이를
 * 주문으로 메웁니다(`ledger-sync.js`). 다만 1회·하루 매수 한도가 있어 큰 차이는
 * 며칠에 걸쳐 줄고, 대사 불일치·긴급 중지로 멈추면 안 줄어듭니다 — 그래서
 * 줄어드는지를 매일 아침 이 줄로 봅니다.
 *
 * **평가액은 장부의 마지막 가격으로 환산합니다.** 브로커 조회(`getPositions`)는
 * 수량만 줍니다 — 대사를 수량으로 하는 편이 정확하기 때문입니다. 가격을 따로
 * 받아오지 않는 이유도 같습니다. 여기 달러는 크기를 보이려는 것이고 대사가
 * 읽는 값이 아닙니다.
 */
/**
 * 실계좌가 실제로 얼마를 벌고 있는지 적습니다 (2026-09-18).
 *
 * **토스가 주는 숫자를 그대로 적습니다. 계산하지 않습니다.** `/api/v1/holdings`는
 * `averagePurchasePrice`·`marketValue.purchaseAmount`·`profitLoss`를 함께 주는데,
 * `getPositions`가 수량만 남기고 버리고 있었습니다. **브로커가 진실이므로**
 * 우리가 평균원가를 다시 세면 어긋나기만 합니다 — 9/17 매도에서 우리 평균원가는
 * $33.6024, 토스가 쓴 원가는 $33.5552였습니다.
 *
 * **미실현뿐입니다.** 실현손익은 어느 엔드포인트에도 없습니다. 그래서 같은 날부터
 * `cost-basis.js`가 원가와 환율을 하루 한 줄씩 쌓습니다 — `purchaseAmount`가
 * 줄어든 만큼이 판 원가라, **다음 매도부터** 실현손익과 환차를 토스 숫자로 낼 수
 * 있습니다. 9/17 건은 그 줄이 없어 소급되지 않습니다.
 *
 * **위 「실계좌 보유」 칸은 안 건드렸습니다.** 그 칸은 장부 가격으로 환산해 장부와
 * 나란히 읽는 칸이고, 이 칸은 토스가 말하는 손익입니다. 목적이 다릅니다.
 */
function formatAccountPnlLines(account, state) {
  if (!account || account.error) return [];

  const holdings = (account.holdings ?? []).filter((row) => row.purchaseAmountUsd !== null);
  if (holdings.length === 0) return [];

  const total = summarizeHoldings(holdings);
  if (!total) return [];

  // **위 「실계좌 보유」 칸과 같은 순서입니다.** 두 칸을 눈으로 나란히 읽으라고
  // 붙인 칸인데 하나는 장부 순서, 하나는 알파벳순이면 그 비교가 안 됩니다.
  const booked = Object.keys(state?.positions ?? {});
  const ordered = [
    ...booked
      .map((symbol) => holdings.find((row) => row.symbol === symbol))
      .filter(Boolean),
    ...holdings.filter((row) => !booked.includes(row.symbol)),
  ];

  const rows = ordered.map((row) => {
    const rate = row.unrealizedRate === null ? null : signedPct(row.unrealizedRate * 100);
    const priced = row.averagePriceUsd !== null && row.lastPriceUsd !== null
      ? `평단 $${row.averagePriceUsd.toFixed(2)} → $${row.lastPriceUsd.toFixed(2)} · `
      : "";
    return `• ${row.symbol}: ${priced}${signedUsd(row.unrealizedUsd ?? 0)}` +
      (rate ? ` (${rate})` : "");
  });

  return [
    "",
    "실계좌 손익 (토스 기준 · 미실현만)",
    `매입 $${total.purchaseUsd.toFixed(2)} → 평가 $${total.marketUsd.toFixed(2)} · ` +
      `${signedUsd(total.unrealizedUsd)}` +
      (total.unrealizedRate === null ? "" : ` (${signedPct(total.unrealizedRate * 100)})`),
    ...rows,
  ];
}

function formatAccountLines(account, state, summary) {
  // 계좌를 못 읽었다고 보고서를 안 보내지는 않습니다. 못 읽었다고 적습니다 —
  // 실주문 원장과 같은 규칙입니다.
  if (account.error) return [`⚠️ 실계좌를 조회하지 못했습니다: ${account.error}`];

  const positions = account.positions ?? {};
  // **장부 칸과 같은 순서로 적습니다.** 두 칸을 눈으로 나란히 읽으라고 붙인
  // 칸인데 순서가 다르면 그 비교가 안 됩니다. 장부에 없는 종목은 뒤에 붙입니다.
  const booked = Object.keys(state.positions ?? {});
  const symbols = [
    ...booked.filter((symbol) => symbol in positions),
    ...Object.keys(positions).filter((symbol) => !booked.includes(symbol)).sort(),
  ];
  if (symbols.length === 0) return ["• 없음"];

  let accountValueUsd = 0;
  let priced = true;
  const lines = symbols.map((symbol) => {
    const quantity = Number(positions[symbol]) || 0;
    const book = state.positions?.[symbol];
    const price = book?.lastPrice ?? book?.entryPrice;
    if (!(price > 0)) {
      // 장부에 없는 종목은 환산할 가격이 없습니다. 수량만 적고 합계는 포기합니다
      // — 모르는 것을 0으로 더하면 차이가 실제보다 커 보입니다.
      priced = false;
      return `• ${symbol}: ${quantity.toFixed(6)}주 (평가액 미상 — 장부에 가격이 없습니다)`;
    }
    const valueUsd = quantity * price;
    accountValueUsd += valueUsd;
    return `• ${symbol}: ${quantity.toFixed(6)}주 ($${valueUsd.toFixed(2)})`;
  });

  if (!priced) return lines;

  const gapUsd = summary.marketValueUsd - accountValueUsd;
  if (Math.abs(gapUsd) < 0.01) return lines;

  return [
    ...lines,
    `⚠️ 장부 $${summary.marketValueUsd.toFixed(2)} ≠ 실계좌 $${accountValueUsd.toFixed(2)} ` +
      `— 차이 $${Math.abs(gapUsd).toFixed(2)}. 실계좌가 매 사이클 한도 안에서 장부를 따라갑니다`,
  ];
}

/**
 * 오늘 실제로 나간 주문을 적습니다. **가상 거래와 같은 줄에 섞지 않습니다** —
 * 둘의 차이가 곧 실행 비용이라, 섞으면 재려던 것이 사라집니다.
 *
 * 미결 건수는 오늘 것만이 아니라 **원장 전체**를 셉니다. 미결 하나가 다음
 * 사이클을 통째로 멈추는데(`unresolvedOrders`), 그것이 8/07에 난 주문 때문이라도
 * 내일 아침 멈추는 것은 똑같기 때문입니다.
 */
function formatLiveLines(live) {
  // 원장을 못 읽었다고 보고서를 안 보내지는 않습니다. 못 읽었다고 적습니다.
  if (live.error) return [`⚠️ 실주문 원장을 읽지 못했습니다: ${live.error}`];

  const orders = Array.isArray(live.orders) ? live.orders : [];
  const lines = orders.length
    ? orders.map((order) =>
        `• ${order.side} ${order.symbol}: 요청 $${Number(order.requestedUsd ?? 0).toFixed(2)} → ` +
        `체결 $${Number(order.filledUsd ?? 0).toFixed(2)} ` +
        `(${Number(order.filledQuantity ?? 0).toFixed(6)}주) [${order.state}]`,
      )
    : ["• 없음"];

  return live.unresolvedCount
    ? [
        ...lines,
        `⚠️ 결말이 안 난 주문 ${live.unresolvedCount}건 — 풀릴 때까지 매매가 멈춥니다`,
      ]
    : lines;
}

// 신호가 왜 비어 있는지 사람이 읽을 수 있는 문장으로 옮깁니다.
const UNAVAILABLE_REASONS = {
  NOT_LOADED: "수집 실패",
  NO_DAILY_CLOSES: "일봉 종가 수집 실패",
  INSUFFICIENT_HISTORY: "일봉 200개 대기 중",
  NO_PRICE_SNAPSHOTS: "가격 표본 없음",
  INSUFFICIENT_SAMPLES: "표본 34개 대기 중",
  UNAVAILABLE: "사용 불가",
};

/**
 * 시장 신호 요약을 만듭니다.
 * 신호가 꺼져 있어도 줄을 생략하지 않습니다. 예전에는 사용 불가한 레이어의 줄이
 * 통째로 빠져서, 가중치 1.0짜리 추세 신호가 12일간 죽은 것을 아무도 몰랐습니다.
 */
function formatMacroLines(macro) {
  if (!macro) return ["통합 시장 상태: 사용 가능한 신호 없음"];

  const layers = Array.isArray(macro.layers) ? macro.layers : [];
  const dead = layers.filter((layer) => !layer.available && Number(layer.weight) > 0);
  return [
    `통합 시장 상태: ${macro.regime} (점수 ${macro.score})`,
    ...formatStackLines(macro.weights),
    ...(layers.length ? [`신호 기여: ${layers.map(formatContribution).join(" · ")}`] : []),
    ...(dead.length
      ? [`⚠️ 비활성 신호: ${dead.map((layer) => `${layer.label}(${reasonText(layer.reason)})`).join(", ")}`]
      : []),
    formatSentimentLine(macro),
    ...formatTrendLines(macro),
    formatMacdLine(macro),
    ...(Number(macro.exposureMultiplier) < 1
      ? [
          `변동성 관리: 연율 ${(Number(macro.volatilityAnnualized) * 100).toFixed(1)}% → ` +
            `주식 익스포저 ×${macro.exposureMultiplier}`,
        ]
      : []),
    `목표 비중: ${formatAllocation(macro.targetAllocation)}`,
  ];
}

/**
 * **어떤 가중치로 돌고 있는지 매일 적습니다.**
 *
 * 2026-08-21까지 이 줄이 없었습니다. 보고서는 기여도(`뉴스 감성 -0.228`)만 찍었고,
 * 기여도가 0이 아닌 것은 정상 동작과 구분되지 않았습니다. 그래서 문서·코드
 * 기본값·테스트가 전부 0이라고 적은 감성 가중치가 **운영 `.env`에서만 1**인 채로
 * 사흘 동안 목표 현금을 3.5%→5.0%로 밀고 있었는데도 드러나지 않았습니다.
 *
 * **기여도는 층이 무엇을 했는지 말해 주지만, 그 층이 켜져 있어도 되는지는 말해
 * 주지 않습니다.**
 */
function formatStackLines(weights) {
  if (!weights) return [];
  const line =
    `실행 스택: 거시 ${weights.macro} · 감성 ${weights.sentiment} · ` +
    `추세 ${weights.trend} · MACD ${weights.macd} · volTarget ${weights.volTarget}`;
  // 판정이 끝나지 않은 층이 켜져 있으면 그 사실을 스택 바로 아래에 답니다.
  return Number(weights.sentiment) !== 0
    ? [line, "⚠️ 미검증 층 작동 중: 감성 가중치가 0이 아닙니다 — 2026-10-30 판정 전까지는 0이어야 합니다"]
    : [line];
}

function formatContribution(layer) {
  if (!layer.available) return `${layer.label} —`;
  const value = Number(layer.contribution);
  return `${layer.label} ${value >= 0 ? "+" : ""}${value}`;
}

function reasonText(reason) {
  return UNAVAILABLE_REASONS[reason] ?? reason ?? "사용 불가";
}

function layerOf(macro, key) {
  return (Array.isArray(macro.layers) ? macro.layers : []).find((layer) => layer.key === key);
}

function formatSentimentLine(macro) {
  if (!macro.sentiment) {
    return `무료 뉴스 감성: 사용 불가 — ${reasonText(layerOf(macro, "NEWS")?.reason)}`;
  }

  const { sentiment } = macro;
  // 기사 수가 갑자기 반토막 나면 소스 하나가 빠진 것입니다. 그 사실이 감성 부호를
  // 바꾸고 목표 비중까지 흔들기 때문에 수집 상태를 항상 함께 보여줍니다.
  const sources = formatSourceCounts(sentiment.sourceCounts);
  return (
    `무료 뉴스 감성: ${sentiment.sentiment_score} ` +
    `(신뢰도 ${sentiment.confidence}, ${sentiment.articleCount}건${sources})` +
    formatFreshness(macro.sentimentFreshness) +
    `${sentiment.stale ? " ※ 캐시 사용" : ""}` +
    `${sentiment.warning ? ` ※ 일부 수집 실패: ${sentiment.warning}` : ""}`
  );
}

/**
 * 스냅샷 나이와 감쇠 배수를 함께 보여줍니다.
 *
 * 07-23~07-31 보고서에서 감성 값이 소수점 3자리까지 4일간 동일했는데,
 * 리포트만 봐서는 그게 "뉴스가 안 변한 것"인지 "캐시가 재사용된 것"인지
 * 구분할 방법이 없었습니다. 나이를 찍으면 보고서 자체가 그 답을 갖게 됩니다.
 */
function formatFreshness(freshness) {
  if (!freshness || freshness.ageHours === null) return "";
  const age = `수집 ${freshness.ageHours}시간 전`;
  if (freshness.multiplier === 0) return ` ※ ${age} — 오래돼 판단에서 제외`;
  if (freshness.multiplier < 1) return ` ※ ${age}, 신선도 ×${freshness.multiplier}`;
  return ` (${age})`;
}

function formatSourceCounts(sourceCounts) {
  const entries = Object.entries(sourceCounts ?? {}).filter(([, count]) => Number(count) > 0);
  return entries.length ? ` — ${entries.map(([name, count]) => `${name} ${count}`).join(", ")}` : "";
}

/**
 * 추세 줄과, 일봉이 끊겼을 때의 경고입니다.
 *
 * **추세가 통째로 죽으면 `⚠️ 비활성 신호`가 이미 잡습니다**(가중치 1 × 사용 불가).
 * 안 잡히던 것은 **살아 있지만 얼어붙은 경우**입니다 — 수집이 실패해도 캐시가
 * 있으면 그 종가로 점수가 나오고, 예전에는 `※ 캐시 사용` 넉 자만 붙었습니다.
 * 값이 어제와 같은 것이 "시장이 안 움직였다"와 구분되지 않습니다. 감성에서
 * 똑같은 일을 겪고 나이를 찍기로 한 것과 같은 이유입니다(`formatFreshness`).
 *
 * **종목 일부만 실패하는 경우는 비율에도 안 나타납니다.** `3/3종목`의 분모는
 * 관심종목이 아니라 **종가를 받아온 종목**이라, IWM이 빠지면 `2/2종목`이 되어
 * 여전히 만점처럼 보입니다. 그래서 실패한 종목을 따로 적습니다.
 */
function formatTrendLines(macro) {
  const trend = macro.trend;
  if (!trend) {
    return [`추세(200일선): 사용 불가 — ${reasonText(layerOf(macro, "TREND")?.reason)}`];
  }

  const lines = [
    `추세(200일선): ${trend.score} ` +
      `(신뢰도 ${trend.confidence}, ${trend.readySymbols}/${trend.totalSymbols}종목)` +
      `${trend.stale ? " ※ 캐시 사용" : ""}`,
  ];

  if (trend.stale) {
    const age = staleAgeHours(trend);
    lines.push(
      "⚠️ 추세 일봉이 갱신되지 않았습니다" +
        (age === null ? "" : ` — 캐시는 ${age}시간 전 값이고`) +
        " 점수가 그 시점에 멈춰 있습니다" +
        (trend.fetchError ? ` (${trend.fetchError})` : ""),
    );
  }

  const failures = Array.isArray(trend.failures) ? trend.failures : [];
  if (failures.length) {
    lines.push(
      `⚠️ 추세 일봉 일부 수집 실패: ${failures.join(", ")} — ` +
        "남은 종목만으로 점수를 냅니다",
    );
  }

  return lines;
}

/**
 * 캐시가 몇 시간 전 값인지입니다.
 *
 * **지금이 아니라 사이클이 돈 시각(`evaluatedAt`) 기준입니다.** 보고서는 장이
 * 닫힌 뒤에 나가므로 지금 시각으로 재면 실제보다 늙어 보이고, 우리가 알고
 * 싶은 것은 **그 점수가 만들어질 때 얼마나 낡아 있었는가**입니다.
 */
function staleAgeHours({ staleSince, evaluatedAt }) {
  const since = new Date(staleSince ?? "").getTime();
  const at = new Date(evaluatedAt ?? "").getTime();
  if (!Number.isFinite(since) || !Number.isFinite(at) || at < since) return null;
  return Math.round(((at - since) / (60 * 60 * 1000)) * 10) / 10;
}

function formatMacdLine(macro) {
  if (macro.macd) {
    return (
      `MACD: ${macro.macd.score} ` +
      `(신뢰도 ${macro.macd.confidence}, ${macro.macd.readySymbols}/${macro.macd.totalSymbols}종목)`
    );
  }
  return `MACD: 사용 불가 — ${reasonText(layerOf(macro, "MACD")?.reason)}`;
}

function formatAllocation(allocation = {}) {
  return Object.entries(allocation)
    .map(([symbol, weight]) => `${symbol} ${(Number(weight) * 100).toFixed(0)}%`)
    .join(", ");
}

/** 정책믹스 비중을 "VTI70·SCHD20·현금10"처럼 한 줄로 줄입니다. */
function formatMix(mix) {
  return Object.entries(mix ?? {})
    .filter(([, weight]) => Number(weight) > 0)
    .map(([symbol, weight]) =>
      `${symbol === "CASH" ? "현금" : symbol}${Math.round(Number(weight) * 100)}`)
    .join("·");
}

/**
 * 원화로 얼마가 됐는지 적습니다 (2026-09-18).
 *
 * **이 보고서는 원금을 원화로 적고 수익률을 달러로 적습니다.** 그 둘이 같은
 * 블록에 있으면 읽는 사람이 "10만 원의 -0.343% = -343원"을 계산합니다. 9/17
 * 기준 실제 답은 **-8,231원**이고 24배 틀립니다. **빠진 것이 아니라 틀린
 * 인상을 주는 배치였습니다** — 그래서 9월 동결에 예외를 뒀습니다.
 *
 * 환율은 이 시스템에 한 번만 쓰입니다 — `createUsdBudget`이 10만 원을 $67.05로
 * 바꾸는 순간뿐이고(`trading-budget.js`), 그 뒤 모든 손익이 달러입니다. 개설
 * 환율이 `state.funding.krwPerUsd`에 남아 있으므로 **오늘 환율 하나만 더하면**
 * 원화 손익이 환율 몫과 전략 몫으로 갈립니다.
 *
 * 9/17에 잰 값: 원금 대비 -8,231원 중 환율이 -7,915원(96.2%), 전략이 -316원.
 * **보고서가 다투던 -$0.23이 그 -316원입니다.**
 *
 * **점수·비중·주문은 안 바뀝니다.** 재는 것만 늘어납니다.
 *
 * **못 읽으면 숨기지 않고 말합니다.** 조용히 빼면 원화가 안 보이던 상태로
 * 돌아가고, 그것이 애초의 문제였습니다.
 */
function formatKrwLines(state, summary, fx) {
  const openRate = Number(state.funding?.krwPerUsd);
  // 이 필드가 생기기 전의 장부입니다. 없는 것을 경고로 바꾸지 않습니다.
  if (!Number.isFinite(openRate) || openRate <= 0) return [];

  const nowRate = Number(fx?.rate);
  if (!fx || fx.error || !Number.isFinite(nowRate) || nowRate <= 0) {
    const why = fx?.error ? ` — ${fx.error}` : "";
    return [`원화 환산: ⚠️ 오늘 환율을 못 읽었습니다${why}`];
  }

  const krwNow = summary.equityUsd * nowRate;
  const krwPnl = krwNow - summary.fundingKrw;
  // **환율 몫은 개설 때 환전한 달러에만 붙습니다.** 전략 몫은 그 뒤 달러가 늘거나
  // 준 것을 오늘 환율로 본 것입니다. 나머지는 10만 원 중 센트 절사로 환전되지
  // 않고 남은 잔돈이고(`budget.reserveKrw`), 셋을 더하면 정확히 krwPnl입니다.
  const fxKrw = summary.fundedUsd * (nowRate - openRate);
  const stratKrw = (summary.equityUsd - summary.fundedUsd) * nowRate;
  const restKrw = krwPnl - fxKrw - stratKrw;
  const pct = summary.fundingKrw > 0 ? (krwPnl / summary.fundingKrw) * 100 : 0;

  return [
    `원화 환산(오늘 ${krw(nowRate, 2)}원): ${krw(krwNow)}원 — ` +
      `원금 ${krw(summary.fundingKrw)}원 대비 ${signedKrw(krwPnl)} (${pct.toFixed(1)}%)`,
    `└ 환율 ${signedKrw(fxKrw)} (개설 ${krw(openRate, 2)}원) · 전략 ${signedKrw(stratKrw)}` +
      (Math.round(Math.abs(restKrw)) >= 1 ? ` · 미환전 ${signedKrw(restKrw)}` : ""),
  ];
}

function krw(value, digits = 0) {
  return Number(value).toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** `signedUsd`와 같은 규칙입니다. 양수에 `+`가 없으면 옆의 금액과 어긋나 보입니다. */
function signedPct(value) {
  const number = Number(value);
  return `${number >= 0 ? "+" : "-"}${Math.abs(number).toFixed(2)}%`;
}

/** `signedUsd`와 같은 규칙입니다 — 부호를 앞에 두고 절대값을 적습니다. */
function signedKrw(value) {
  const rounded = Math.round(Number(value));
  return `${rounded >= 0 ? "+" : "-"}${Math.abs(rounded).toLocaleString("ko-KR")}원`;
}

function signedUsd(value) {
  const number = Number(value);
  return `${number >= 0 ? "+" : "-"}$${Math.abs(number).toFixed(2)}`;
}

/** 이 손익이 언제부터의 것인지 한 칸에 적습니다. */
function sinceLabel(startedAt) {
  return typeof startedAt === "string" && startedAt.length >= 10
    ? `${startedAt.slice(0, 10)}~`
    : "시작일 불명";
}

/**
 * 초과성과 한 줄.
 *
 * 구간을 맞출 수 없으면 **숫자를 내지 않습니다.** 예전에는 시작일이 다른 두
 * 손익을 그냥 빼서, 기준선이 열리기 전 구간의 손익까지 초과성과에 실렸습니다.
 * 빈 값 대신 왜 못 냈는지를 적습니다.
 */
function alphaLine(label, window, startedAt) {
  if (!window || window.alphaUsd === null || window.alphaUsd === undefined) {
    return `${label}: 계산 안 함 — 기준선 개설일(${sinceLabel(startedAt)})의 지갑 자산을 모릅니다`;
  }
  const approx = window.anchorSource === "DAY_START" ? " · 개설일 시작 자산 기준" : "";
  return `${label}: ${signedUsd(window.alphaUsd)} (${sinceLabel(startedAt)} 같은 구간${approx})`;
}

/**
 * **마지막 사이클이 언제였는지 적습니다.**
 *
 * 거래 0건에 상태가 그대로인 날은 두 가지입니다 — 밴드 안이라 조용한 날과,
 * **사이클이 아예 안 돈 날**입니다. 보고서는 별도 타이머라 매매가 멈춰도
 * 평소처럼 나가므로, 그 둘이 여기서 구분되지 않으면 며칠이 지나도 모릅니다.
 * (원인은 여럿입니다 — 남은 잠금, 토큰 만료, 디스크, 타이머 정지.)
 *
 * 보고서는 장 마감 10분 뒤에 나가고 사이클은 정규장 중 15분마다 도니까,
 * 건강한 날의 나이는 30분 안입니다. 두 시간을 넘기면 장중 어딘가에서 멈춘 것입니다.
 */
const CYCLE_STALE_MS = 2 * 60 * 60 * 1000;

function cycleFreshnessLines(state, now) {
  const at = Date.parse(state.lastCycleAt ?? "");
  // 이 기록이 생기기 전의 장부입니다. 없는 것을 경고로 바꾸지 않습니다.
  if (!Number.isFinite(at)) return [];

  const ageMs = Math.max(0, now.getTime() - at);
  const age = ageMs < 60 * 60 * 1000
    ? `${Math.round(ageMs / 60000)}분`
    : `${Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10}시간`;
  return ageMs > CYCLE_STALE_MS
    ? [`⚠️ 마지막 사이클: ${age} 전 — 그 뒤로 매매도 대사도 돌지 않았습니다`]
    : [`마지막 사이클: ${age} 전`];
}

function formatRiskReason(reason) {
  if (reason === "TOTAL_LOSS_LIMIT") return "누적 손실 한도 도달";
  if (reason === "DAILY_LOSS_LIMIT") return "일일 손실 한도 도달";
  return reason;
}
