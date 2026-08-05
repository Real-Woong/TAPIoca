import { summarizePaperState } from "../paper/paper-engine.js";

export function formatDailyReport(state, tradingDate, dateForTrade) {
  // 저장된 마지막 가격을 기준으로 가상 자산을 요약합니다.
  // 실제 Toss 계좌의 보유 종목이나 예수금은 이 보고서에 포함하지 않습니다.
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
    "📊 Toss ETF PAPER 일일 보고서",
    `거래일(뉴욕): ${tradingDate}`,
    "",
    `초기 원금: ${summary.fundingKrw.toLocaleString("ko-KR")}원 ($${summary.fundedUsd.toFixed(2)})`,
    `현재 총자산: $${summary.equityUsd.toFixed(2)}`,
    `현금: $${summary.cashUsd.toFixed(2)}`,
    `ETF 평가액: $${summary.marketValueUsd.toFixed(2)}`,
    `누적손익: ${signedUsd(summary.totalPnlUsd)} (${summary.returnPct}%)`,
    `실현손익: ${signedUsd(summary.realizedPnlUsd)}`,
    `미실현손익: ${signedUsd(summary.unrealizedPnlUsd)}`,
    ...(summary.feesUsd ? [`누적 거래비용: -$${summary.feesUsd.toFixed(2)}`] : []),
    ...(summary.benchmark
      ? [
          `벤치마크(${summary.benchmark.symbol} 매수후보유): ` +
            `${signedUsd(summary.benchmark.pnlUsd)} (${summary.benchmark.returnPct}%)`,
          `초과성과(alpha): ${signedUsd(summary.alphaUsd)}`,
        ]
      : []),
    `누적 거래: ${summary.tradeCount}건`,
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
    "보유 ETF",
    ...positionLines,
    "",
    "오늘의 가상 거래",
    ...tradeLines,
    "",
    "PAPER 모드 — 실제 주문 없음",
  ].join("\n");
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
    ...(layers.length ? [`신호 기여: ${layers.map(formatContribution).join(" · ")}`] : []),
    ...(dead.length
      ? [`⚠️ 비활성 신호: ${dead.map((layer) => `${layer.label}(${reasonText(layer.reason)})`).join(", ")}`]
      : []),
    formatSentimentLine(macro),
    formatTrendLine(macro),
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

function formatTrendLine(macro) {
  if (macro.trend) {
    const stale = macro.trend.stale ? " ※ 캐시 사용" : "";
    return (
      `추세(200일선): ${macro.trend.score} ` +
      `(신뢰도 ${macro.trend.confidence}, ` +
      `${macro.trend.readySymbols}/${macro.trend.totalSymbols}종목)${stale}`
    );
  }
  return `추세(200일선): 사용 불가 — ${reasonText(layerOf(macro, "TREND")?.reason)}`;
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

function signedUsd(value) {
  const number = Number(value);
  return `${number >= 0 ? "+" : "-"}$${Math.abs(number).toFixed(2)}`;
}

function formatRiskReason(reason) {
  if (reason === "TOTAL_LOSS_LIMIT") return "누적 손실 한도 도달";
  if (reason === "DAILY_LOSS_LIMIT") return "일일 손실 한도 도달";
  return reason;
}
