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

// 2026-08-27: 기준선마다 시작일이 다른데 초과성과가 그 사실을 무시하고 뺐다.
// 지갑 손익은 자금 투입일부터, 정책믹스 기준선은 운영 상태에서 20일 뒤부터라,
// 그 20일치 손익이 통째로 "신호 초과성과"로 들어가 있었다. 시작일을 함께 찍고
// **겹치는 구간에서만** 뺀다.
function reportFixture(overrides = {}) {
  return {
    createdAt: "2026-07-14T13:43:19.602Z",
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 6.39,
    realizedPnlUsd: -0.25,
    positions: {
      VTI: { symbol: "VTI", quantity: 0.15, entryPrice: 290, lastPrice: 293.2, costUsd: 43.5 },
    },
    trades: [],
    // 이 기준선은 개설 시점의 지갑 자산을 직접 들고 있다(새로 열리는 기준선).
    benchmark: { symbol: "VTI", quantity: 0.2296, entryPriceUsd: 292, lastPrice: 301.75,
      fundedUsd: 67.05, startedAt: "2026-07-27T13:30:00Z", walletEquityUsdAtStart: 66.71 },
    // 이쪽은 그 값이 없는 옛 기준선이라 위험 관리의 일별 시작 자산으로 대신한다.
    policyBenchmark: {
      mix: { VTI: 0.7, SCHD: 0.2, IWM: 0, CASH: 0.1 },
      fundedUsd: 67.05,
      cashUsd: 6.71,
      positions: { VTI: { quantity: 0.1607, lastPrice: 301.75 } },
      startedAt: "2026-07-14T14:00:00Z",
    },
    risk: { dailyStartEquityUsd: { "2026-07-14": 67.05 } },
    ...overrides,
  };
}

test("정책믹스 기준선과 그 대비 초과성과를 보고서에 함께 알린다", () => {
  const report = formatDailyReport(reportFixture(), "2026-08-05");

  assert.match(report, /정책믹스\(VTI70·SCHD20·현금10 고정 · 2026-07-14~\)/);
  assert.match(report, /└ 신호 초과성과: [+-]\$/);
  // VTI 100% 벤치마크도 그대로 남아야 한다. 기준선을 갈아치우는 게 아니라 더하는 것이다.
  assert.match(report, /벤치마크\(VTI 매수후보유 · 2026-07-27~\)/);
  assert.match(report, /초과성과\(alpha\)/);
  // 지갑이 언제부터의 손익인지도 함께 찍는다. 세 시작일이 다르다는 것이 보여야 한다.
  assert.match(report, /누적손익\(2026-07-14~\)/);
});

test("초과성과는 기준선이 열린 날부터의 지갑 손익에서 뺀다", () => {
  const report = formatDailyReport(reportFixture(), "2026-08-05");

  // 지갑 자산 = 6.39 + 0.15×293.2 = 50.37
  // VTI 기준선 손익 = 0.2296×301.75 − 67.05 = +2.23
  // 07-27부터의 지갑 손익 = 50.37 − 66.71 = −16.34 → alpha = −18.57
  // (옛 방식은 자금 투입일부터의 −16.68에서 빼 −18.91이었다.)
  assert.match(report, /초과성과\(alpha\): -\$18\.57 \(2026-07-27~ 같은 구간\)/);

  // 정책믹스 손익 = 6.71 + 0.1607×301.75 − 67.05 = −11.85
  // 07-14부터의 지갑 손익 = 50.37 − 67.05 = −16.68 → alpha = −4.83
  // 개설 시점 값이 없어 일별 시작 자산으로 맞췄다는 사실을 줄에 남긴다.
  assert.match(
    report,
    /└ 신호 초과성과: -\$4\.83 \(2026-07-14~ 같은 구간 · 개설일 시작 자산 기준\)/,
  );
});

// 구간을 못 맞추면 숫자를 만들어내지 않는다. 틀린 숫자를 맞는 것처럼 보여주는 것이
// 애초에 고치려던 문제다.
test("기준선 개설일의 지갑 자산을 모르면 초과성과를 내지 않는다", () => {
  const state = reportFixture({ risk: undefined });
  delete state.benchmark.walletEquityUsdAtStart;

  const report = formatDailyReport(state, "2026-08-05");

  assert.match(report, /초과성과\(alpha\): 계산 안 함 — 기준선 개설일\(2026-07-27~\)의/);
  assert.match(report, /└ 신호 초과성과: 계산 안 함/);
  // 기준선 자체의 손익은 그대로 보여준다. 못 내는 것은 뺄셈뿐이다.
  assert.match(report, /정책믹스\(VTI70·SCHD20·현금10 고정 · 2026-07-14~\): [+-]\$/);
});

// 2026-08-21: 보고서가 기여도(`뉴스 감성 -0.228`)만 찍어서, 문서가 0이라고 적은
// 감성 가중치가 운영 .env에서만 1인 채로 사흘간 배분을 밀고 있는 것을 놓쳤다.
// 기여도가 0이 아닌 것은 정상 동작과 구분되지 않는다. 가중치를 직접 적는다.
function stateWithWeights(weights) {
  return {
    funding: { fundingKrw: 100000, fundedUsd: 67.05 },
    cashUsd: 1.5,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    macro: {
      regime: "NEUTRAL",
      score: 0.748,
      targetAllocation: { VTI: 0.7, SCHD: 0.18, IWM: 0.08, CASH: 0.05 },
      weights,
      layers: [
        { key: "NEWS", label: "뉴스 감성", weight: weights.sentiment, available: true,
          contribution: -0.228 },
        { key: "TREND", label: "추세(200일선)", weight: 1, available: true, contribution: 0.976 },
      ],
    },
  };
}

test("보고서가 실행 중인 가중치를 그대로 적는다", () => {
  const report = formatDailyReport(
    stateWithWeights({ macro: 0, sentiment: 0, trend: 1, macd: 0, volTarget: 0.15 }),
    "2026-08-19",
  );

  assert.match(report, /실행 스택: 거시 0 · 감성 0 · 추세 1 · MACD 0 · volTarget 0\.15/);
  assert.doesNotMatch(report, /미검증 층 작동 중/);
});

test("판정 전인 감성 층이 켜져 있으면 보고서가 경고한다", () => {
  // 실제로 08-18~20에 돌던 스택이다. 통합 점수 0.748 = 추세 0.976 + 감성 -0.228.
  const report = formatDailyReport(
    stateWithWeights({ macro: 0, sentiment: 1, trend: 1, macd: 0, volTarget: 0.15 }),
    "2026-08-19",
  );

  assert.match(report, /실행 스택: 거시 0 · 감성 1 /);
  assert.match(report, /⚠️ 미검증 층 작동 중: 감성 가중치가 0이 아닙니다/);
});
