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

test("손실 안전장치가 작동하면 보고서에 신규 매수 중단을 표시한다", () => {
  const state = {
    funding: { fundingKrw: 100000, fundedUsd: 67.03 },
    cashUsd: 67.03,
    realizedPnlUsd: 0,
    positions: {},
    trades: [],
    risk: {
      lastCheck: { buyPaused: true, reason: "DAILY_LOSS_LIMIT" },
    },
  };

  const report = formatDailyReport(state, "2026-07-14");

  assert.match(report, /일일 손실 한도 도달/);
  assert.match(report, /신규 매수 중단/);
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
