import test from "node:test";
import assert from "node:assert/strict";

import { formatDailyReport } from "../src/telegram/daily-report-format.js";

test("일일 보고서에 원금, 손익, 보유종목과 당일 거래를 포함한다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.03 },
    cashUsd: 62.03,
    realizedPnlUsd: 0,
    positions: {
      VTI: { symbol: "VTI", quantity: 0.05, entryPrice: 100, lastPrice: 102, costUsd: 5 },
    },
    trades: [{
      side: "BUY", symbol: "VTI", amountUsd: 5, reason: "INITIAL_PAPER_ENTRY",
      executedAt: "2026-07-14T14:00:00Z",
    }],
  };

  const report = formatDailyReport(state, "2026-07-14");

  assert.match(report, /100,000원/);
  assert.match(report, /VTI/);
  assert.match(report, /BUY VTI/);
  assert.match(report, /실현손익/);
  assert.match(report, /미실현손익/);
  assert.match(report, /PAPER 모드/);
});

test("손실 한도에 닿으면 경고를 표시하되 매매는 계속한다고 알린다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.03 },
    cashUsd: 67.03,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    risk: {
      lastCheck: {
        alert: true, reason: "DAILY_LOSS_LIMIT", totalPnlUsd: -2.1, dailyPnlUsd: -3.4,
      },
    },
  };

  const report = formatDailyReport(state, "2026-07-14");

  assert.match(report, /일일 손실 한도 도달/);
  // 자동 중단은 폭락 중에 위험관리를 꺼버려 오히려 낙폭을 키웠다. 이제는 알리기만 한다.
  assert.match(report, /매매는 계속합니다/);
  assert.doesNotMatch(report, /신규 매수 중단/);
});

test("신호가 꺼져 있어도 줄을 생략하지 않고 사유와 경고를 함께 알린다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 67.05,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "RISK_OFF",
      score: -2.222,
      targetAllocation: { VTI: 0.4, SCHD: 0.2, CASH: 0.4 },
      sentiment: { sentiment_score: -0.653, confidence: 0.589, articleCount: 70 },
      trend: null,
      macd: { score: 0.31379, confidence: 1, readySymbols: 3, totalSymbols: 3 },
      layers: [
        { key: "FRED", label: "거시(FRED)", weight: null, available: true, contribution: -1.5 },
        { key: "NEWS", label: "뉴스 감성", weight: 2, available: true, contribution: -0.769 },
        { key: "TREND", label: "추세(200일선)", weight: 1, available: false, contribution: 0,
          reason: "NO_DAILY_CLOSES" },
        { key: "MACD", label: "MACD", weight: 0.15, available: true, contribution: 0.047 },
      ],
    },
  };

  const report = formatDailyReport(state, "2026-07-23");

  assert.match(report, /추세\(200일선\): 사용 불가 — 일봉 종가 수집 실패/);
  assert.match(report, /⚠️ 비활성 신호: 추세\(200일선\)\(일봉 종가 수집 실패\)/);
  assert.match(report, /신호 기여: .*거시\(FRED\) -1\.5.*MACD \+0\.047/);
});

test("레이어 정보가 없는 예전 상태도 그대로 렌더한다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 67.05,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "NEUTRAL",
      score: -1.2,
      targetAllocation: { VTI: 0.7, SCHD: 0.2, CASH: 0.1 },
    },
  };

  const report = formatDailyReport(state, "2026-07-23");

  assert.match(report, /통합 시장 상태: NEUTRAL/);
  assert.match(report, /추세\(200일선\): 사용 불가 — 사용 불가/);
  assert.doesNotMatch(report, /⚠️/);
});

test("뉴스 소스 구성과 부분 수집 실패를 보고서에 함께 알린다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 67.05,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "RISK_OFF",
      score: -2.2,
      targetAllocation: { VTI: 0.4, CASH: 0.4 },
      sentiment: {
        sentiment_score: -0.653,
        confidence: 0.589,
        articleCount: 70,
        sourceCounts: { FED_RSS: 70, GDELT: 0 },
        warning: "GDELT 응답 오류 503",
      },
      layers: [],
    },
  };

  const report = formatDailyReport(state, "2026-07-23");

  assert.match(report, /FED_RSS 70/);
  assert.match(report, /※ 일부 수집 실패: GDELT 응답 오류 503/);
});

// 08-05 실보고서에서 감성 줄에 수집 시각이 끝내 찍히지 않았습니다. 원인은 포맷터가
// 아니라 compactMacroSignal이 sentimentFreshness를 상태에 옮기지 않은 것이었습니다.
// 기존 보고서 테스트는 state.macro를 손으로 만들어서 이 누락을 잡지 못했으므로,
// 여기서는 신호 결합 → 사이클 → 보고서까지 실제 경로로 확인합니다.
test("감성 수집 시각이 신호 결합에서 보고서까지 살아남는다", async () => {
  const { combineMarketSignals } = await import("../src/sentiment/market-signal.js");
  const { createPaperState, runPaperCycle } = await import("../src/paper/paper-engine.js");
  const { createUsdBudget } = await import("../src/paper/trading-budget.js");
  const { loadTradingPolicy } = await import("../src/paper/trading-policy.js");

  const now = new Date("2026-08-05T12:00:00Z");
  const combined = combineMarketSignals(
    { score: -0.5, regime: "NEUTRAL", targetAllocation: { VTI: 0.7, CASH: 0.3 }, reasons: [] },
    {
      sentiment_score: 0.108,
      confidence: 0.611,
      articleCount: 434,
      // 반감기 6시간 기준 3시간 지난 스냅샷이므로 나이와 감쇠 배수가 함께 찍힙니다.
      fetchedAt: "2026-08-05T09:00:00Z",
    },
    { sentimentWeight: 1, now },
  );
  assert.equal(combined.sentimentFreshness.ageHours, 3);

  const state = createPaperState({
    budget: createUsdBudget("67.05"), watchlist: ["VTI"], now,
  });
  const result = runPaperCycle(
    state,
    [{ symbol: "VTI", lastPrice: 100 }],
    loadTradingPolicy({ MAX_ORDER_USD: "5", MAX_DAILY_BUY_USD: "10" }),
    now,
    combined,
  );

  assert.equal(result.state.macro.sentimentFreshness.ageHours, 3);
  assert.match(
    formatDailyReport(result.state, "2026-08-05"),
    /무료 뉴스 감성: .* ※ 수집 3시간 전, 신선도 ×0\.707/,
  );
});
