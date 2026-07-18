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
        `거시경제 상태: ${state.macro.regime} (점수 ${state.macro.score})`,
        `목표 비중: ${formatAllocation(state.macro.targetAllocation)}`,
      ]
    : ["거시경제 상태: 사용 가능한 신호 없음"];

  return [
    "📊 Toss ETF PAPER 일일 보고서",
    `거래일(뉴욕): ${tradingDate}`,
    "",
    `초기 원금: ${summary.fundingKrw.toLocaleString("ko-KR")}원 ($${summary.fundedUsd.toFixed(2)})`,
    `현재 총자산: $${summary.equityUsd.toFixed(2)}`,
    `현금: $${summary.cashUsd.toFixed(2)}`,
    `ETF 평가액: $${summary.marketValueUsd.toFixed(2)}`,
    `누적손익: ${signedUsd(summary.totalPnlUsd)}`,
    `누적 거래: ${summary.tradeCount}건`,
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
