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
  const macroLines = state.macro
    ? [
        `통합 시장 상태: ${state.macro.regime} (점수 ${state.macro.score})`,
        ...(state.macro.sentiment
          ? [
              `무료 뉴스 감성: ${state.macro.sentiment.sentiment_score} ` +
                `(신뢰도 ${state.macro.sentiment.confidence}, ${state.macro.sentiment.articleCount}건)`,
            ]
          : []),
        ...(state.macro.trend
          ? [
              `추세(200일선): ${state.macro.trend.score} ` +
                `(신뢰도 ${state.macro.trend.confidence}, ` +
                `${state.macro.trend.readySymbols}/${state.macro.trend.totalSymbols}종목)`,
            ]
          : []),
        ...(state.macro.macd
          ? [
              `MACD: ${state.macro.macd.score} ` +
                `(신뢰도 ${state.macro.macd.confidence}, ` +
                `${state.macro.macd.readySymbols}/${state.macro.macd.totalSymbols}종목)`,
            ]
          : []),
        `목표 비중: ${formatAllocation(state.macro.targetAllocation)}`,
      ]
    : ["통합 시장 상태: 사용 가능한 신호 없음"];

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
    ...(summary.benchmark
      ? [
          `벤치마크(${summary.benchmark.symbol} 매수후보유): ` +
            `${signedUsd(summary.benchmark.pnlUsd)} (${summary.benchmark.returnPct}%)`,
          `초과성과(alpha): ${signedUsd(summary.alphaUsd)}`,
        ]
      : []),
    `누적 거래: ${summary.tradeCount}건`,
    ...(state.risk?.lastCheck?.buyPaused
      ? [`안전 중단: ${formatRiskReason(state.risk.lastCheck.reason)} — 신규 매수 중단`]
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
